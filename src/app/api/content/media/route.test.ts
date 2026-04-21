import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

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

const blob = {
  delCalls: [] as string[],
  delThrow: null as Error | null,
};

vi.mock("@vercel/blob", () => ({
  del: (url: string) => {
    blob.delCalls.push(url);
    if (blob.delThrow) return Promise.reject(blob.delThrow);
    return Promise.resolve();
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  blob.delCalls = [];
  blob.delThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
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
  const req = new NextRequest(`http://localhost/api/content/media${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

async function callDelete(body?: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "DELETE",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/content/media", init);
  return mod.DELETE(req);
}

describe("GET /api/content/media", () => {
  it("401 when not admin", async () => {
    expect((await callGet("", false)).status).toBe(401);
  });

  it("default list returns media + stats + pagination", async () => {
    fake.results.push([
      { id: "m-1", url: "https://b.test/a.png", size_bytes: 100 },
    ]);
    fake.results.push([{ total: "5", total_bytes: "5120" }]);
    const res = await callGet();
    const body = (await res.json()) as {
      media: unknown[];
      stats: { total: number; total_size_bytes: number };
      pagination: { returned: number };
    };
    expect(body.media).toHaveLength(1);
    expect(body.stats.total).toBe(5);
    expect(body.stats.total_size_bytes).toBe(5120);
    expect(body.pagination.returned).toBe(1);
  });

  it("folder filter uses WHERE clause", async () => {
    fake.results.push([]);
    fake.results.push([{ total: "0", total_bytes: "0" }]);
    await callGet("?folder=uploads");
    const q = fake.calls[0]!.strings.join("?");
    expect(q).toContain("WHERE folder");
  });
});

describe("DELETE /api/content/media", () => {
  it("401 when not admin", async () => {
    expect((await callDelete({ id: "m-1" }, false)).status).toBe(401);
  });

  it("400 when id missing", async () => {
    expect((await callDelete({})).status).toBe(400);
  });

  it("404 when media not found", async () => {
    fake.results.push([]); // SELECT empty
    expect((await callDelete({ id: "missing" })).status).toBe(404);
  });

  it("happy path deletes blob + DB row", async () => {
    fake.results.push([{ url: "https://b.test/file.png" }]);
    fake.results.push([]); // DELETE
    const res = await callDelete({ id: "m-1" });
    expect(res.status).toBe(200);
    expect(blob.delCalls).toEqual(["https://b.test/file.png"]);
    const deleteQuery = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM uploaded_media"),
    );
    expect(deleteQuery).toBeDefined();
  });

  it("blob del failure is swallowed, DB delete still runs", async () => {
    blob.delThrow = new Error("blob 500");
    fake.results.push([{ url: "https://b.test/file.png" }]);
    fake.results.push([]); // DELETE
    const res = await callDelete({ id: "m-1" });
    expect(res.status).toBe(200);
    const deleteQuery = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM uploaded_media"),
    );
    expect(deleteQuery).toBeDefined();
  });
});
