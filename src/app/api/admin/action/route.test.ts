import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const cacheClearMock = vi.fn();
const cacheDelMock = vi.fn();
vi.mock("@/lib/cache", () => ({
  cache: {
    clear: () => cacheClearMock(),
    del: (...args: unknown[]) => cacheDelMock(...args),
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  cacheClearMock.mockReset();
  cacheDelMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/action", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("POST /api/admin/action — auth + validation", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ action: "clear_cache" })).status).toBe(401);
  });

  it("400 when action missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({})).status).toBe(400);
  });

  it("returns 500 with message on unknown action", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ action: "fly_to_moon" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Unknown action");
  });
});

describe("POST /api/admin/action — deferred (501)", () => {
  beforeEach(() => { mockIsAdmin = true; });

  it("refresh_personas returns 501 with SEED_PERSONAS reason", async () => {
    const res = await callPOST({ action: "refresh_personas" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { details: { reason: string } };
    expect(body.details.reason).toContain("SEED_PERSONAS");
  });

  it("generate_content returns 501 with media-stack reason", async () => {
    const res = await callPOST({ action: "generate_content" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { details: { reason: string } };
    expect(body.details.reason).toContain("media stack");
  });
});

describe("POST /api/admin/action — clear_cache", () => {
  it("clears the L1 cache", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ action: "clear_cache" });
    expect(res.status).toBe(200);
    expect(cacheClearMock).toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain("L1 cache cleared");
  });
});

describe("POST /api/admin/action — heal_personas", () => {
  it("reactivates orphan seed personas + busts the cache", async () => {
    mockIsAdmin = true;
    fake.results = [[{ id: "glitch-001" }, { id: "glitch-002" }]];
    const res = await callPOST({ action: "heal_personas" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; details: { ids: string[] } };
    expect(body.message).toContain("Healed 2");
    expect(body.details.ids).toEqual(["glitch-001", "glitch-002"]);
    expect(cacheDelMock).toHaveBeenCalledWith("personas:active");
  });
});

describe("POST /api/admin/action — sync_balances", () => {
  it("returns holder count + total circulating", async () => {
    mockIsAdmin = true;
    fake.results = [[{ total_holders: 42, total_circulating: "12345.67" }]];
    const res = await callPOST({ action: "sync_balances" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { details: { holders: number; total_circulating: number } };
    expect(body.details.holders).toBe(42);
    expect(body.details.total_circulating).toBe(12345.67);
  });
});

describe("POST /api/admin/action — run_diagnostics", () => {
  it("collates row counts + recent cron_runs with graceful fallback", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ count: 100 }],   // posts
      [{ count: 110 }],   // ai_personas
      [{ count: 50 }],    // human_users
      [{ count: 5 }],     // dead personas
      [{ count: 2 }],     // inactive personas
      [{ cron_name: "sponsor-burn", status: "ok", started_at: "2026-04-21", error: null }],
    ];
    const res = await callPOST({ action: "run_diagnostics" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      details: {
        posts: number;
        personas: number;
        users: number;
        dead_personas: number;
        inactive_personas: number;
        recent_crons: unknown[];
      };
    };
    expect(body.details.posts).toBe(100);
    expect(body.details.personas).toBe(110);
    expect(body.details.users).toBe(50);
    expect(body.details.dead_personas).toBe(5);
    expect(body.details.inactive_personas).toBe(2);
    expect(body.details.recent_crons).toHaveLength(1);
  });

  it("reports zero counts when all tables missing", async () => {
    mockIsAdmin = true;
    fake.results = Array.from({ length: 6 }, () => new Error("table missing"));
    const res = await callPOST({ action: "run_diagnostics" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { details: { posts: number; recent_crons: unknown[] } };
    expect(body.details.posts).toBe(0);
    expect(body.details.recent_crons).toEqual([]);
  });
});
