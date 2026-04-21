import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];

const fake = {
  results: [] as (RowSet | Error)[],
};

function fakeSql(..._args: unknown[]): Promise<RowSet> {
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

vi.mock("@/lib/ai/cost-ledger", () => ({
  getLifetimeTotals:  () => Promise.resolve({ totalUsd: 12.34, totalCalls: 500 }),
  getCostHistory:     () => Promise.resolve([
    { date: "2026-04-21", provider: "xai", task_type: "reply_to_human", total_usd: 1.2, count: 20 },
  ]),
  getDailySpendTotals: () => Promise.resolve([
    { date: "2026-04-21", total_usd: 2.5, count: 50 },
  ]),
}));

vi.mock("@/lib/ai/circuit-breaker", () => ({
  getBreakerStatus: () => Promise.resolve({ xai: "closed", anthropic: "closed", redisAvailable: true }),
}));

beforeEach(() => {
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/stats"));
}

// The stats route fires 30+ individual safeCount/safeRows queries. To
// simulate "everything is empty", we just leave fake.results empty — each
// call returns [] via fakeSql's fallback, which each safe helper coerces
// to 0 or [].

describe("GET /api/admin/stats", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns the full dashboard shape with defaults when DB is empty", async () => {
    mockIsAdmin = true;
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_users: number;
      total_personas: number;
      active_users_24h: number;
      server_status: string;
      overview: { totalPosts: number; activePersonas: number };
      mediaBreakdown: { videos: number; images: number; memes: number };
      specialContent: { beefThreads: number; challenges: number; bookmarks: number };
      aiCosts: {
        lifetime: { total_usd: number; total_calls: number };
        history: unknown[];
        personaBreakdown: unknown[];
        circuitBreaker: { xai: string; anthropic: string };
      };
      communityEvents: { activeEvents: number };
    };

    expect(body.server_status).toBe("ok");
    expect(body.total_users).toBe(0);
    expect(body.overview.totalPosts).toBe(0);
    expect(body.mediaBreakdown.videos).toBe(0);
    expect(body.specialContent.bookmarks).toBe(0);
    expect(body.aiCosts.lifetime.total_usd).toBe(12.34);
    expect(body.aiCosts.history).toHaveLength(1);
    expect(body.aiCosts.personaBreakdown).toEqual([]);
    expect(body.aiCosts.circuitBreaker.xai).toBe("closed");
    expect(body.communityEvents.activeEvents).toBe(0);
  });

  it("populates counts when DB returns data", async () => {
    mockIsAdmin = true;
    // Order of safeCount fires: totalPosts, totalComments, totalPersonas,
    // activePersonas, totalHumanLikes, totalAILikes, totalSubscriptions,
    // totalUsers — we populate only the first 4 and let the rest default 0.
    fake.results = [
      [{ count: 1000 }],  // totalPosts
      [{ count: 500 }],   // totalComments
      [{ count: 110 }],   // totalPersonas
      [{ count: 108 }],   // activePersonas
    ];
    const res = await callGET();
    const body = (await res.json()) as {
      overview: { totalPosts: number; totalComments: number; totalPersonas: number; activePersonas: number };
      total_personas: number;
    };
    expect(body.overview.totalPosts).toBe(1000);
    expect(body.overview.totalComments).toBe(500);
    expect(body.overview.activePersonas).toBe(108);
    expect(body.total_personas).toBe(110);
  });

  it("degrades gracefully when optional tables throw (beef/challenges/events/swaps/messages)", async () => {
    mockIsAdmin = true;
    // Make many queries throw — safeCount/safeRows should catch each
    fake.results = Array.from({ length: 40 }, () => new Error("table missing"));
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { server_status: string; specialContent: { beefThreads: number } };
    expect(body.server_status).toBe("ok");
    expect(body.specialContent.beefThreads).toBe(0);
  });
});
