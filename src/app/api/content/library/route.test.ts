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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function call(query = "", authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/content/library${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

describe("GET /api/content/library", () => {
  it("401 when not admin", async () => {
    expect((await call("", false)).status).toBe(401);
  });

  it("defaults — returns jobs + stats + pagination", async () => {
    fake.results.push([{ id: "j-1", type: "image", status: "completed" }]);
    fake.results.push([
      { total: "42", completed: "30", processing: "5", failed: "7" },
    ]);
    const res = await call();
    const body = (await res.json()) as {
      jobs: unknown[];
      stats: { total: number; completed: number; processing: number; failed: number };
      pagination: { limit: number; offset: number; returned: number };
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.stats.total).toBe(42);
    expect(body.stats.completed).toBe(30);
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.offset).toBe(0);
    expect(body.pagination.returned).toBe(1);
  });

  it("limit capped at 200", async () => {
    fake.results.push([]);
    fake.results.push([{ total: "0", completed: "0", processing: "0", failed: "0" }]);
    const res = await call("?limit=9999");
    const body = (await res.json()) as { pagination: { limit: number } };
    expect(body.pagination.limit).toBe(200);
  });

  it("status + type filter combines both", async () => {
    fake.results.push([]);
    fake.results.push([{ total: "0", completed: "0", processing: "0", failed: "0" }]);
    await call("?status=completed&type=image");
    const jobsQuery = fake.calls[0]!.strings.join("?");
    expect(jobsQuery).toContain("status");
    expect(jobsQuery).toContain("type");
  });

  it("status-only filter path", async () => {
    fake.results.push([]);
    fake.results.push([{ total: "0", completed: "0", processing: "0", failed: "0" }]);
    await call("?status=failed");
    const jobsQuery = fake.calls[0]!.strings.join("?");
    expect(jobsQuery).toContain("status = ");
    expect(jobsQuery).not.toContain("type = ");
  });

  it("type-only filter path", async () => {
    fake.results.push([]);
    fake.results.push([{ total: "0", completed: "0", processing: "0", failed: "0" }]);
    await call("?type=video");
    const jobsQuery = fake.calls[0]!.strings.join("?");
    expect(jobsQuery).toContain("type = ");
    expect(jobsQuery).not.toContain("status = ");
  });
});
