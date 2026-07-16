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

    // CREATE + pause SELECT + throttle SELECT + INSERT + UPDATE = 5
    expect(fake.calls.length).toBe(5);
    expect(result.processed).toBe(5);
    expect(result._cron_run_id).toBeDefined();

    const insertCall = fake.calls[3]!;
    expect(insertCall.values).toContain("test-job");
    const insertSql = insertCall.strings.join("");
    expect(insertSql).toContain("running");

    const updateCall = fake.calls[4]!;
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

    // CREATE + pause + throttle + INSERT + UPDATE error = 5
    expect(fake.calls.length).toBe(5);
    const updateCall = fake.calls[4]!;
    const updateSql = updateCall.strings.join("");
    expect(updateSql).toContain("'error'");
    expect(updateCall.values).toContain("something broke");
  });

  it("only runs CREATE TABLE once per module lifetime", async () => {
    const { cronHandler } = await getCronHandler();

    await cronHandler("job-a", async () => ({}));
    await cronHandler("job-b", async () => ({}));

    // First: CREATE + pause + throttle + INSERT + UPDATE = 5
    // Second: pause + throttle + INSERT + UPDATE = 4
    expect(fake.calls.length).toBe(9);
  });

  it("merges _cron_run_id into the returned result", async () => {
    const { cronHandler } = await getCronHandler();
    const result = await cronHandler("id-test", async () => ({ x: 1, y: "hello" }));
    expect(result.x).toBe(1);
    expect(result.y).toBe("hello");
    expect(typeof result._cron_run_id).toBe("string");
  });

  it("skips fn when job is paused (admin alias key)", async () => {
    const { cronHandler } = await getCronHandler();
    const fn = vi.fn(async () => ({ ran: true }));

    // CREATE [], pause OR-query returns paused, then INSERT skipped row
    // For generate-persona-content, pause uses 2-key OR query
    fake.results = [
      [], // CREATE
      [{ value: "true" }], // pause hit via alias
      // no throttle query — paused short-circuits
    ];

    const result = await cronHandler("generate-persona-content", fn);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skipped: true,
      reason: "paused",
      cron: "generate-persona-content",
    });

    const insertSql = fake.calls[2]!.strings.join("");
    expect(insertSql).toContain("throttled");
  });

  it("skips fn when activity throttle is 0%", async () => {
    const { cronHandler } = await getCronHandler();
    const fn = vi.fn(async () => ({ ran: true }));

    fake.results = [
      [], // CREATE
      [], // not paused
      [{ value: "0" }], // throttle 0%
    ];

    const result = await cronHandler("general-content", fn);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, reason: "throttled" });
  });

  it("skipThrottle bypasses pause and activity checks", async () => {
    const { cronHandler } = await getCronHandler();
    const fn = vi.fn(async () => ({ ran: true }));

    const result = await cronHandler("general-content", fn, { skipThrottle: true });

    expect(fn).toHaveBeenCalled();
    expect(result.ran).toBe(true);
    // CREATE + INSERT + UPDATE only (no pause/throttle)
    expect(fake.calls.length).toBe(3);
  });
});
