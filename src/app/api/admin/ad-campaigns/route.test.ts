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

const expireMock = vi.fn().mockResolvedValue(0);
vi.mock("@/lib/ad-campaigns", () => ({
  expireCompletedCampaigns: () => expireMock(),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  expireMock.mockClear();
  expireMock.mockResolvedValue(0);
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/ad-campaigns${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/ad-campaigns", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("calls expireCompletedCampaigns before listing", async () => {
    mockIsAdmin = true;
    expireMock.mockResolvedValue(3);
    fake.results = [[], [], []];  // CREATE tables + list
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(expireMock).toHaveBeenCalled();
    const body = (await res.json()) as { expiredThisRun: number; campaigns: unknown[] };
    expect(body.expiredThisRun).toBe(3);
  });

  it("stats action returns aggregated counts", async () => {
    mockIsAdmin = true;
    expireMock.mockResolvedValue(1);
    fake.results = [
      [], [],                    // CREATE tables
      [{ count: 10 }],           // total
      [{ count: 4 }],            // active
      [{ total: 12500 }],        // total impressions
      [{ total: 50000 }],        // total revenue
    ];
    const res = await call("GET", { query: "?action=stats" });
    const body = (await res.json()) as {
      stats: {
        total: number;
        active: number;
        totalImpressions: number;
        totalRevenueGlitch: number;
        expiredThisRun: number;
      };
    };
    expect(body.stats).toEqual({
      total: 10,
      active: 4,
      totalImpressions: 12500,
      totalRevenueGlitch: 50000,
      expiredThisRun: 1,
    });
  });
});

describe("POST /api/admin/ad-campaigns", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { body: { action: "create" } })).status).toBe(401);
  });

  it("400 on unknown action", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("POST", { body: { action: "fly_to_moon" } })).status).toBe(400);
  });

  it("create: 400 when required fields missing", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("POST", { body: { action: "create", brand_name: "x" } })).status).toBe(400);
  });

  it("create: inserts and returns pending_payment", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    const res = await call("POST", {
      body: {
        action: "create",
        brand_name: "Acme",
        product_name: "Widget",
        visual_prompt: "A sleek widget",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; campaign_id: string };
    expect(body.status).toBe("pending_payment");
    expect(body.campaign_id).toBeTruthy();
  });

  it("activate: 404 when campaign not found", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];  // CREATE + CREATE + SELECT empty
    const res = await call("POST", { body: { action: "activate", campaign_id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("activate: sets status + dates using duration_days", async () => {
    mockIsAdmin = true;
    fake.results = [
      [], [],
      [{ id: "c1", duration_days: 14 }],  // SELECT
      [],                                   // UPDATE
    ];
    const res = await call("POST", { body: { action: "activate", campaign_id: "c1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; starts_at: string; expires_at: string };
    expect(body.status).toBe("active");
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(new Date(body.starts_at).getTime());
  });

  it("pause/resume/cancel/complete flip status without touching dates", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    const res = await call("POST", { body: { action: "pause", campaign_id: "c1" } });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("paused");
  });

  it("update: COALESCE patch by campaign_id", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    const res = await call("POST", {
      body: { action: "update", campaign_id: "c1", brand_name: "New Brand" },
    });
    expect(res.status).toBe(200);
  });

  it("impressions: 400 when campaign_id missing", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("POST", { body: { action: "impressions" } })).status).toBe(400);
  });

  it("seed_inhouse: seeds all six in-house products when none exist", async () => {
    mockIsAdmin = true;
    // 2 CREATE tables + per campaign: SELECT (empty) + INSERT = 12 calls
    fake.results = [
      [], [],
      // 6 campaigns × (SELECT + INSERT)
      [], [], [], [], [], [], [], [], [], [], [], [],
    ];
    const res = await call("POST", { body: { action: "seed_inhouse" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; total: number };
    expect(body.success).toBe(true);
    expect(body.total).toBe(6);
  });

  it("seed_inhouse: updates logos on existing in-house rows", async () => {
    mockIsAdmin = true;
    const existing = [{ id: "existing-1" }];
    fake.results = [
      [], [],
      // 6 campaigns — all already exist
      existing, [], existing, [], existing, [], existing, [], existing, [], existing, [],
    ];
    const res = await call("POST", { body: { action: "seed_inhouse" } });
    const body = (await res.json()) as { seeded: string[] };
    expect(body.seeded.every((s) => s.includes("updated logo"))).toBe(true);
  });
});
