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

async function call(query = "", authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/admin/migration/metrics${query}`,
    { method: "GET" },
  );
  return mod.GET(req);
}

function seedTable() {
  fake.results.push([]); // CREATE TABLE
  fake.results.push([]); // INDEX
  fake.results.push([]); // INDEX
}

describe("GET /api/admin/migration/metrics", () => {
  it("401 when not admin", async () => {
    expect((await call("", false)).status).toBe(401);
  });

  it("default window is 24h and uses the 24h query", async () => {
    seedTable();
    fake.results.push([]); // metrics rows
    await call();
    const select = fake.calls.find((c) =>
      c.strings.join("?").includes("percentile_cont"),
    );
    expect(select).toBeDefined();
    expect(select!.strings.join("?")).toContain("INTERVAL '24 hours'");
  });

  it("?since=7d picks the 7-day branch", async () => {
    seedTable();
    fake.results.push([]);
    await call("?since=7d");
    const select = fake.calls.find((c) =>
      c.strings.join("?").includes("percentile_cont"),
    );
    expect(select!.strings.join("?")).toContain("INTERVAL '7 days'");
  });

  it("?since=all has no INTERVAL filter", async () => {
    seedTable();
    fake.results.push([]);
    await call("?since=all");
    const select = fake.calls.find((c) =>
      c.strings.join("?").includes("percentile_cont"),
    );
    const sql = select!.strings.join("?");
    expect(sql).not.toContain("INTERVAL");
    expect(sql).toContain("FROM migration_request_log");
  });

  it("coerces numbers + computes error_rate", async () => {
    seedTable();
    fake.results.push([
      {
        path: "/api/feed",
        method_set: "GET",
        total: 10,
        ok: 8,
        errors: 2,
        p50_ms: 120,
        p95_ms: 450,
        last_at: "2026-04-21T10:00:00Z",
      },
    ]);
    const res = await call();
    const body = (await res.json()) as {
      summary: { endpoint_count: number; total_calls: number; total_errors: number };
      metrics: { path: string; methods: string[]; error_rate: number }[];
    };
    expect(body.summary.endpoint_count).toBe(1);
    expect(body.summary.total_calls).toBe(10);
    expect(body.summary.total_errors).toBe(2);
    expect(body.metrics[0]!.methods).toEqual(["GET"]);
    expect(body.metrics[0]!.error_rate).toBe(20); // 2/10 = 20%
  });

  it("handles zero-total endpoint without NaN", async () => {
    seedTable();
    fake.results.push([
      {
        path: "/api/x",
        method_set: "GET",
        total: 0,
        ok: 0,
        errors: 0,
        p50_ms: null,
        p95_ms: null,
        last_at: "2026-04-21T10:00:00Z",
      },
    ]);
    const body = (await (await call()).json()) as {
      metrics: { error_rate: number }[];
    };
    expect(body.metrics[0]!.error_rate).toBe(0);
  });
});
