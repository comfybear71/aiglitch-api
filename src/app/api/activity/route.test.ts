/**
 * Smoke tests for /api/activity rollup.
 *
 * Verifies the response shape the admin.aiglitch.app Activity tab
 * consumes: every field present, sensible defaults when tables are
 * missing, and per-query failures don't kill the whole rollup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as Array<unknown[] | Error>,
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("GET /api/activity", () => {
  it("returns the full rollup shape with empty defaults", async () => {
    // 12 core queries + 5 secondary (throttle, cronHistory, lastCronRuns,
    // cronTrend, cronCosts) — all empty.
    fake.results = Array.from({ length: 17 }, () => []);

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.recentActivity)).toBe(true);
    expect(Array.isArray(body.pendingJobs)).toBe(true);
    expect(Array.isArray(body.completedJobs)).toBe(true);
    expect(body.ads).toEqual({ total: 0, breakdown: [], recent: [] });
    expect(Array.isArray(body.lastPerSource)).toBe(true);
    expect(Array.isArray(body.todayByHour)).toBe(true);
    expect(body.currentlyActive).toBeNull();
    expect(body.breaking).toEqual({ total: 0, lastHour: 0 });
    expect(Array.isArray(body.activeTopics)).toBe(true);
    expect(body.activityThrottle).toBe(100);
    expect(Array.isArray(body.cronHistory)).toBe(true);
    expect(Array.isArray(body.lastCronRuns)).toBe(true);
    expect(Array.isArray(body.cronTrend)).toBe(true);
    expect(Array.isArray(body.cronCosts)).toBe(true);
    expect(Array.isArray(body.cronSchedules)).toBe(true);
    expect(body.cronSchedules.length).toBeGreaterThan(0);
  });

  it("survives individual query failures without blowing up the rollup", async () => {
    // Make one core query and one secondary query reject — rollup must
    // still 200 with empty values for those slots.
    fake.results = [
      new Error("table posts missing"), // recentActivity
      [], // pendingJobs
      [], // completedJobs
      [{ count: 5 }], // adTotal
      [], // adBreakdown
      [], // recentAds
      [], // lastPerSource
      [], // todayByHour
      [], // currentlyActive
      [{ count: 3 }], // breakingCount
      [{ count: 1 }], // recentBreaking
      [], // activeTopics
      new Error("platform_settings missing"), // activityThrottle
      [], // cronHistory
      [], // lastCronRuns
      [], // cronTrend
      [], // cronCosts
    ];

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.recentActivity).toEqual([]); // fell back to []
    expect(body.activityThrottle).toBe(100); // fell back to default
    expect(body.ads.total).toBe(5); // unaffected siblings still populated
    expect(body.breaking.total).toBe(3);
    expect(body.breaking.lastHour).toBe(1);
    // Both failures should have been logged to console.error
    expect(consoleErr).toHaveBeenCalled();
  });

  it("maps cronHistory rows into the camelCased UI shape", async () => {
    fake.results = [
      [], [], [], [{ count: 0 }], [], [], [], [], [], [{ count: 0 }], [{ count: 0 }], [], // 12 core
      [{ value: "75" }], // activityThrottle
      [
        // cronHistory
        {
          id: "r1",
          cron_name: "persona-content",
          status: "completed",
          started_at: "2026-05-27T00:00:00Z",
          finished_at: "2026-05-27T00:00:10Z",
          duration_ms: 10000,
          cost_usd: 0.123,
          result: "ok",
          error: null,
        },
      ],
      [], [], [], // lastCronRuns, cronTrend, cronCosts
    ];

    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();

    expect(body.activityThrottle).toBe(75);
    expect(body.cronHistory).toHaveLength(1);
    expect(body.cronHistory[0]).toEqual({
      id: "r1",
      cronName: "persona-content",
      status: "completed",
      startedAt: "2026-05-27T00:00:00Z",
      finishedAt: "2026-05-27T00:00:10Z",
      durationMs: 10000,
      costUsd: 0.123,
      result: "ok",
      error: null,
    });
  });
});
