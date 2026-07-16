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

async function loadThrottle() {
  vi.resetModules();
  return import("./throttle");
}

describe("pauseSettingKeys", () => {
  it("includes admin UI alias for persona content", async () => {
    const { pauseSettingKeys } = await loadThrottle();
    expect(pauseSettingKeys("generate-persona-content")).toEqual([
      "cron_paused_generate-persona-content",
      "cron_paused_persona-content",
    ]);
  });

  it("includes reverse alias", async () => {
    const { pauseSettingKeys } = await loadThrottle();
    expect(pauseSettingKeys("persona-content")).toEqual([
      "cron_paused_persona-content",
      "cron_paused_generate-persona-content",
    ]);
  });
});

describe("isCronPaused", () => {
  it("returns false when no pause row", async () => {
    const { isCronPaused } = await loadThrottle();
    fake.results = [[]];
    expect(await isCronPaused("general-content")).toBe(false);
  });

  it("returns true when admin alias key is paused", async () => {
    const { isCronPaused } = await loadThrottle();
    // OR query returns a matching paused row
    fake.results = [[{ value: "true" }]];
    expect(await isCronPaused("generate-persona-content")).toBe(true);
  });
});

describe("shouldRunCron", () => {
  it("returns true at default (no row = 100%)", async () => {
    const { shouldRunCron } = await loadThrottle();
    fake.results = [[]];
    expect(await shouldRunCron("general-content")).toBe(true);
  });

  it("hard-stops at 0% with no staleness bypass", async () => {
    const { shouldRunCron } = await loadThrottle();
    fake.results = [[{ value: "0" }]];
    expect(await shouldRunCron("generate-persona-content")).toBe(false);
    // Only throttle SELECT — no posts staleness query
    expect(fake.calls.length).toBe(1);
  });

  it("returns true at 100%", async () => {
    const { shouldRunCron } = await loadThrottle();
    fake.results = [[{ value: "100" }]];
    expect(await shouldRunCron("ai-trading")).toBe(true);
  });
});
