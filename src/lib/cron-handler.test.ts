import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function getCronHandler() {
  vi.resetModules();
  const mod = await import("./cron-handler");
  mod.__resetCronTableFlag();
  return mod;
}

describe("cronHandler", () => {
  it("inserts a running row, runs fn, updates to ok", async () => {
    const { cronHandler } = await getCronHandler();

    const result = await cronHandler("test-job", async () => ({ processed: 5 }));

    // CREATE TABLE IF NOT EXISTS + INSERT + UPDATE = 3 queries
    expect(fake.calls.length).toBe(3);
    expect(result.processed).toBe(5);
    expect(result._cron_run_id).toBeDefined();

    // INSERT passes id, name, 'running' (literal in SQL string, not value)
    const insertCall = fake.calls[1]!;
    expect(insertCall.values).toContain("test-job");
    // 'running' is a SQL literal in the template string, not a bound value
    const insertSql = insertCall.strings.join("");
    expect(insertSql).toContain("running");

    // UPDATE sets status='ok' (literal in SQL string)
    const updateCall = fake.calls[2]!;
    const updateSql = updateCall.strings.join("");
    expect(updateSql).toContain("'ok'");
  });

  it("updates row to error and re-throws on fn failure", async () => {
    const { cronHandler } = await getCronHandler();

    await expect(
      cronHandler("failing-job", async () => {
        throw new Error("something broke");
      }),
    ).rejects.toThrow("something broke");

    // CREATE TABLE + INSERT + UPDATE (error)
    expect(fake.calls.length).toBe(3);
    const updateCall = fake.calls[2]!;
    // 'error' is a SQL literal in the template string
    const updateSql = updateCall.strings.join("");
    expect(updateSql).toContain("'error'");
    expect(updateCall.values).toContain("something broke");
  });

  it("only runs CREATE TABLE once per module lifetime", async () => {
    const { cronHandler } = await getCronHandler();

    await cronHandler("job-a", async () => ({}));
    await cronHandler("job-b", async () => ({}));

    // First call: CREATE + INSERT + UPDATE = 3
    // Second call: INSERT + UPDATE = 2 (no CREATE)
    // Total: 5
    expect(fake.calls.length).toBe(5);
  });

  it("merges _cron_run_id into the returned result", async () => {
    const { cronHandler } = await getCronHandler();
    const result = await cronHandler("id-test", async () => ({ x: 1, y: "hello" }));
    expect(result.x).toBe(1);
    expect(result.y).toBe("hello");
    expect(typeof result._cron_run_id).toBe("string");
  });
});
