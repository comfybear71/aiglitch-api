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

beforeEach(async () => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
  const mod = await import("./request-log");
  mod.__resetRequestLogTableFlag();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("insertRequestLog", () => {
  it("creates table on first call and inserts row", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([]); // CREATE INDEX (created_at)
    fake.results.push([]); // CREATE INDEX (path)
    fake.results.push([]); // INSERT

    const { getDb } = await import("@/lib/db");
    const { insertRequestLog } = await import("./request-log");
    const sql = getDb();
    const id = await insertRequestLog(sql, {
      method: "POST",
      path: "/api/admin/test",
      status: 200,
      durationMs: 42,
      requestBody: { x: 1 },
      responseBody: "ok",
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    // CREATE TABLE was called
    expect(
      fake.calls.some((c) =>
        c.strings.join("?").includes("CREATE TABLE IF NOT EXISTS migration_request_log"),
      ),
    ).toBe(true);
    // INSERT was called
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO migration_request_log"),
    );
    expect(insert).toBeDefined();
    expect(insert!.values).toContain("POST");
    expect(insert!.values).toContain("/api/admin/test");
    expect(insert!.values).toContain(200);
    expect(insert!.values).toContain(42);
  });

  it("truncates response body to 2KB", async () => {
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    const { getDb } = await import("@/lib/db");
    const { insertRequestLog } = await import("./request-log");
    const sql = getDb();
    const huge = "x".repeat(5000);
    await insertRequestLog(sql, {
      method: "GET",
      path: "/api/x",
      responseBody: huge,
    });
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO migration_request_log"),
    );
    const responseValue = insert!.values.find(
      (v) => typeof v === "string" && v.startsWith("x"),
    ) as string;
    expect(responseValue.length).toBeLessThanOrEqual(2048);
  });

  it("second insert skips CREATE TABLE (cached flag)", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([]); // CREATE INDEX
    fake.results.push([]); // CREATE INDEX
    fake.results.push([]); // INSERT 1
    fake.results.push([]); // INSERT 2

    const { getDb } = await import("@/lib/db");
    const { insertRequestLog } = await import("./request-log");
    const sql = getDb();
    await insertRequestLog(sql, { method: "GET", path: "/api/x" });
    await insertRequestLog(sql, { method: "GET", path: "/api/y" });

    const tableCreates = fake.calls.filter((c) =>
      c.strings.join("?").includes("CREATE TABLE IF NOT EXISTS migration_request_log"),
    );
    expect(tableCreates).toHaveLength(1);
  });
});

describe("listRequestLog", () => {
  it("default list with no filters", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([]); // INDEX
    fake.results.push([]); // INDEX
    fake.results.push([{ id: "a", method: "GET", path: "/api/x" }]); // SELECT
    const { getDb } = await import("@/lib/db");
    const { listRequestLog } = await import("./request-log");
    const rows = await listRequestLog(getDb());
    expect(rows).toHaveLength(1);
    const select = fake.calls.find((c) => c.strings.join("?").includes("SELECT *"));
    expect(select).toBeDefined();
    expect(select!.strings.join("?")).not.toContain("WHERE");
  });

  it("path filter routes to path-only branch", async () => {
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]); // SELECT
    const { getDb } = await import("@/lib/db");
    const { listRequestLog } = await import("./request-log");
    await listRequestLog(getDb(), { pathFilter: "/api/x" });
    const select = fake.calls.find((c) => c.strings.join("?").includes("SELECT *"));
    expect(select!.strings.join("?")).toContain("WHERE path");
    expect(select!.values).toContain("/api/x");
  });

  it("path + status=error combines both filters", async () => {
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    const { getDb } = await import("@/lib/db");
    const { listRequestLog } = await import("./request-log");
    await listRequestLog(getDb(), {
      pathFilter: "/api/x",
      statusFilter: "error",
    });
    const select = fake.calls.find((c) => c.strings.join("?").includes("SELECT *"));
    const sql = select!.strings.join("?");
    expect(sql).toContain("path =");
    expect(sql).toContain("status >= 400");
  });

  it("limit capped at 200", async () => {
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    const { getDb } = await import("@/lib/db");
    const { listRequestLog } = await import("./request-log");
    await listRequestLog(getDb(), { limit: 9999 });
    const select = fake.calls.find((c) => c.strings.join("?").includes("SELECT *"));
    expect(select!.values).toContain(200);
  });
});

describe("clearRequestLog", () => {
  it("returns count of deleted rows", async () => {
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([{ id: "1" }, { id: "2" }]);
    const { getDb } = await import("@/lib/db");
    const { clearRequestLog } = await import("./request-log");
    const n = await clearRequestLog(getDb());
    expect(n).toBe(2);
  });
});
