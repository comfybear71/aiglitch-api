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

async function call() {
  vi.resetModules();
  const mod = await import("./route");
  return mod.GET();
}

/**
 * Seed the Promise.all parallel block (12 queries) + all the follow-up
 * optional blocks with empty arrays, unless specific rows are provided.
 * Order MUST match the route's call sequence.
 */
function seedBase(overrides: Partial<{
  recentActivity: unknown[];
  pendingJobs: unknown[];
  completedJobs: unknown[];
  adTotal: unknown[];
  adBreakdown: unknown[];
  recentAds: unknown[];
  lastPerSource: unknown[];
  todayByHour: unknown[];
  currentlyActive: unknown[];
  breakingCount: unknown[];
  recentBreaking: unknown[];
  activeTopics: unknown[];
}> = {}) {
  fake.results.push(overrides.recentActivity ?? []);
  fake.results.push(overrides.pendingJobs ?? []);
  fake.results.push(overrides.completedJobs ?? []);
  fake.results.push(overrides.adTotal ?? [{ count: 0 }]);
  fake.results.push(overrides.adBreakdown ?? []);
  fake.results.push(overrides.recentAds ?? []);
  fake.results.push(overrides.lastPerSource ?? []);
  fake.results.push(overrides.todayByHour ?? []);
  fake.results.push(overrides.currentlyActive ?? []);
  fake.results.push(overrides.breakingCount ?? [{ count: 0 }]);
  fake.results.push(overrides.recentBreaking ?? [{ count: 0 }]);
  fake.results.push(overrides.activeTopics ?? []);
}

/** After the Promise.all, the route runs sequential optional blocks. */
function seedOptional(
  opts: {
    directorTotal?: unknown[] | Error;
    directorGenerating?: unknown[] | Error;
    directorLast?: unknown[] | Error;
    recentMovies?: unknown[] | Error;
    clipDiag?: unknown[] | Error;
    throttle?: unknown[] | Error;
    cronHistory?: unknown[] | Error;
    lastCronRuns?: unknown[] | Error;
    cronTrend?: unknown[] | Error;
    cronCosts?: unknown[] | Error;
  } = {},
) {
  fake.results.push(opts.directorTotal ?? []);
  fake.results.push(opts.directorGenerating ?? []);
  fake.results.push(opts.directorLast ?? []);
  fake.results.push(opts.recentMovies ?? []);
  if (opts.clipDiag !== undefined) fake.results.push(opts.clipDiag);
  fake.results.push(opts.throttle ?? []);
  fake.results.push(opts.cronHistory ?? []);
  fake.results.push(opts.lastCronRuns ?? []);
  fake.results.push(opts.cronTrend ?? []);
  fake.results.push(opts.cronCosts ?? []);
}

describe("GET /api/activity", () => {
  it("returns the expected shape with all-empty tables", async () => {
    seedBase();
    seedOptional();

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty("recentActivity");
    expect(body).toHaveProperty("pendingJobs");
    expect(body).toHaveProperty("completedJobs");
    expect(body).toHaveProperty("ads");
    expect(body).toHaveProperty("lastPerSource");
    expect(body).toHaveProperty("todayByHour");
    expect(body).toHaveProperty("currentlyActive");
    expect(body).toHaveProperty("breaking");
    expect(body).toHaveProperty("activeTopics");
    expect(body).toHaveProperty("activityThrottle");
    expect(body).toHaveProperty("directorStats");
    expect(body).toHaveProperty("recentMovies");
    expect(body).toHaveProperty("cronHistory");
    expect(body).toHaveProperty("lastCronRuns");
    expect(body).toHaveProperty("cronTrend");
    expect(body).toHaveProperty("cronCosts");
    expect(body).toHaveProperty("cronSchedules");

    expect((body.ads as { total: number }).total).toBe(0);
    expect((body.breaking as { total: number }).total).toBe(0);
    expect(body.activityThrottle).toBe(100);
    expect(body.directorStats).toEqual({ total: 0, generating: 0, lastAt: null });
  });

  it("cronSchedules list has the expected 8 entries", async () => {
    seedBase();
    seedOptional();

    const res = await call();
    const body = (await res.json()) as { cronSchedules: unknown[] };
    expect(body.cronSchedules).toHaveLength(8);
  });

  it("ads.breakdown coerces counts + defaults mediaType", async () => {
    seedBase({
      adBreakdown: [
        { source: "grok-aurora", media_type: "image", count: "42" },
        { source: "grok-imagine", media_type: null, count: 7 },
      ],
      adTotal: [{ count: "49" }],
    });
    seedOptional();
    const res = await call();
    const body = (await res.json()) as {
      ads: { total: number; breakdown: { source: string; mediaType: string; count: number }[] };
    };
    expect(body.ads.total).toBe(49);
    expect(body.ads.breakdown).toEqual([
      { source: "grok-aurora", mediaType: "image", count: 42 },
      { source: "grok-imagine", mediaType: "text", count: 7 },
    ]);
  });

  it("director_movies exists → directorStats populated", async () => {
    seedBase();
    seedOptional({
      directorTotal: [{ count: 10 }],
      directorGenerating: [{ count: 2 }],
      directorLast: [{ created_at: "2026-04-21T10:00:00Z" }],
      recentMovies: [
        {
          id: "m1",
          title: "The Glitch",
          genre: "scifi",
          director_username: "noir",
          director_display_name: "Noir Director",
          status: "done",
          clip_count: 5,
          created_at: "2026-04-21T09:00:00Z",
          premiere_post_id: "p1",
          video_url: "https://b.mp4",
        },
      ],
    });
    const res = await call();
    const body = (await res.json()) as {
      directorStats: { total: number; generating: number; lastAt: string | null };
      recentMovies: Array<{ id: string; title: string; director_display_name: string }>;
      lastPerSource: Array<{ source: string; total: number }>;
    };
    expect(body.directorStats.total).toBe(10);
    expect(body.directorStats.generating).toBe(2);
    expect(body.directorStats.lastAt).toBe("2026-04-21T10:00:00Z");
    expect(body.recentMovies).toHaveLength(1);
    expect(body.recentMovies[0]!.director_display_name).toBe("Noir Director");
    // director-movie injected into lastPerSource when not already there
    const injected = body.lastPerSource.find((s) => s.source === "director-movie");
    expect(injected).toBeDefined();
    expect(injected!.total).toBe(10);
  });

  it("director_movies missing → falls back to zeros", async () => {
    seedBase();
    seedOptional({
      directorTotal: new Error("table missing"),
    });
    const res = await call();
    const body = (await res.json()) as {
      directorStats: { total: number };
      recentMovies: unknown[];
    };
    expect(body.directorStats.total).toBe(0);
    expect(body.recentMovies).toEqual([]);
  });

  it("failed/generating movies pull clipDiagnostics when table exists", async () => {
    seedBase();
    seedOptional({
      directorTotal: [{ count: 1 }],
      directorGenerating: [{ count: 1 }],
      directorLast: [{ created_at: "2026-04-21T10:00:00Z" }],
      recentMovies: [
        {
          id: "m-fail",
          title: "Failed",
          genre: "drama",
          director_username: "x",
          director_display_name: "X",
          status: "failed",
          clip_count: 5,
          created_at: "t",
          premiere_post_id: null,
          video_url: null,
        },
      ],
      clipDiag: [
        { movie_id: "m-fail", scene_number: 1, status: "done", fail_reason: null, elapsed_secs: 120 },
        { movie_id: "m-fail", scene_number: 2, status: "failed", fail_reason: "Grok 500", elapsed_secs: 300 },
      ],
    });
    const res = await call();
    const body = (await res.json()) as {
      recentMovies: Array<{
        id: string;
        clipDiagnostics?: { scene: number; status: string; failReason: string | null; elapsedMin: number }[];
      }>;
    };
    const movie = body.recentMovies[0]!;
    expect(movie.clipDiagnostics).toHaveLength(2);
    expect(movie.clipDiagnostics![1]).toEqual({
      scene: 2,
      status: "failed",
      failReason: "Grok 500",
      elapsedMin: 5,
    });
  });

  it("platform_settings missing → throttle defaults to 100", async () => {
    seedBase();
    seedOptional({
      throttle: new Error("missing table"),
    });
    const res = await call();
    const body = (await res.json()) as { activityThrottle: number };
    expect(body.activityThrottle).toBe(100);
  });

  it("platform_settings present → throttle reflects stored value", async () => {
    seedBase();
    seedOptional({
      throttle: [{ value: "42" }],
    });
    const res = await call();
    const body = (await res.json()) as { activityThrottle: number };
    expect(body.activityThrottle).toBe(42);
  });

  it("cron_runs missing → history arrays are empty", async () => {
    seedBase();
    seedOptional({
      cronHistory: new Error("missing"),
    });
    const res = await call();
    const body = (await res.json()) as {
      cronHistory: unknown[];
      lastCronRuns: unknown[];
    };
    expect(body.cronHistory).toEqual([]);
    expect(body.lastCronRuns).toEqual([]);
  });

  it("cron_runs present → entries are coerced", async () => {
    seedBase();
    seedOptional({
      cronHistory: [
        {
          id: "r1",
          cron_name: "telegram-status",
          status: "ok",
          started_at: "2026-04-21T10:00:00Z",
          finished_at: "2026-04-21T10:00:01Z",
          duration_ms: "250",
          cost_usd: "0.01",
          result: "{}",
          error: null,
        },
      ],
      lastCronRuns: [
        { cron_name: "telegram-status", started_at: "2026-04-21T10:00:00Z", status: "ok" },
      ],
    });
    const res = await call();
    const body = (await res.json()) as {
      cronHistory: Array<{
        id: string;
        cronName: string;
        durationMs: number | null;
        costUsd: number | null;
      }>;
      lastCronRuns: Array<{ cronName: string; lastStatus: string }>;
    };
    expect(body.cronHistory[0]!.cronName).toBe("telegram-status");
    expect(body.cronHistory[0]!.durationMs).toBe(250);
    expect(body.cronHistory[0]!.costUsd).toBeCloseTo(0.01);
    expect(body.lastCronRuns[0]!.lastStatus).toBe("ok");
  });

  it("cronCosts query falls through on missing table", async () => {
    seedBase();
    seedOptional({
      cronCosts: new Error("boom"),
    });
    const res = await call();
    const body = (await res.json()) as { cronCosts: unknown[] };
    expect(body.cronCosts).toEqual([]);
  });

  it("director-movie NOT duplicated in lastPerSource when already present", async () => {
    seedBase({
      lastPerSource: [
        { media_source: "director-movie", last_at: "2026-04-20T00:00:00Z", total: "3" },
      ],
    });
    seedOptional({
      directorTotal: [{ count: 10 }],
      directorGenerating: [{ count: 0 }],
      directorLast: [{ created_at: "2026-04-21T10:00:00Z" }],
    });
    const res = await call();
    const body = (await res.json()) as {
      lastPerSource: Array<{ source: string; total: number }>;
    };
    const hits = body.lastPerSource.filter((s) => s.source === "director-movie");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.total).toBe(3);
  });

  it("persona_video_jobs missing → pendingJobs / completedJobs empty", async () => {
    seedBase({
      pendingJobs: [] as unknown[],
      completedJobs: [] as unknown[],
    });
    seedOptional();
    const res = await call();
    const body = (await res.json()) as {
      pendingJobs: unknown[];
      completedJobs: unknown[];
    };
    expect(body.pendingJobs).toEqual([]);
    expect(body.completedJobs).toEqual([]);
  });
});
