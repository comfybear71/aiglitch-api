import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as (RowSet | Error)[] };
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(async () => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
  const mod = await import("@/lib/migration/request-log");
  mod.__resetRequestLogTableFlag();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callGet(query = "", authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/admin/migration/log${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

async function callDelete(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/migration/log", {
    method: "DELETE",
  });
  return mod.DELETE(req);
}

function seedTable() {
  fake.results.push([]); // CREATE TABLE
  fake.results.push([]); // INDEX created_at
  fake.results.push([]); // INDEX path
}

describe("GET /api/admin/migration/log", () => {
  it("401 when not admin", async () => {
    expect((await callGet("", false)).status).toBe(401);
  });

  it("default returns logs + paths + pagination", async () => {
    seedTable();
    fake.results.push([{ id: "a", method: "GET", path: "/api/x", status: 200 }]); // SELECT logs
    fake.results.push([{ path: "/api/x" }, { path: "/api/y" }]); // SELECT distinct paths
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: unknown[];
      paths: string[];
      pagination: { limit: number; offset: number; returned: number };
    };
    expect(body.logs).toHaveLength(1);
    expect(body.paths).toEqual(["/api/x", "/api/y"]);
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.returned).toBe(1);
  });

  it("limit clamped at 200", async () => {
    seedTable();
    fake.results.push([]); // logs
    fake.results.push([]); // paths
    const res = await callGet("?limit=9999");
    const body = (await res.json()) as { pagination: { limit: number } };
    expect(body.pagination.limit).toBe(200);
  });

  it("path + status=error filter both applied", async () => {
    seedTable();
    fake.results.push([]); // logs
    fake.results.push([]); // paths
    await callGet("?path=/api/feed&status=error");
    const logQuery = fake.calls.find((c) => {
      const s = c.strings.join("?");
      return s.includes("SELECT *") && s.includes("path =") && s.includes("status >= 400");
    });
    expect(logQuery).toBeDefined();
  });

  it("invalid status value falls through to 'any'", async () => {
    seedTable();
    fake.results.push([]);
    fake.results.push([]);
    await callGet("?status=nonsense");
    const logQuery = fake.calls.find((c) => c.strings.join("?").includes("SELECT *"));
    expect(logQuery!.strings.join("?")).not.toContain("WHERE");
  });
});

describe("DELETE /api/admin/migration/log", () => {
  it("401 when not admin", async () => {
    expect((await callDelete(false)).status).toBe(401);
  });

  it("returns count of rows deleted", async () => {
    seedTable();
    fake.results.push([{ id: "1" }, { id: "2" }, { id: "3" }]); // DELETE RETURNING
    const res = await callDelete();
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(3);
  });
});
