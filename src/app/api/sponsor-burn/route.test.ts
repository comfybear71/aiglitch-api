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

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

// Campaign started 3 days ago, not yet burned today
const CAMPAIGN = {
  id: "camp-1",
  brand_name: "AcmeCorp",
  price_glitch: 700,
  duration_days: 7,
  starts_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  expires_at: new Date(Date.now() + 4 * 86400000).toISOString(),
  last_burn_at: null,
};

// totalInvestment = 700 + 0 = 700; dailyRate = 700/7 = 100; 3 days missed → burn 300
const SPONSOR = { id: 1, glitch_balance: 700, total_spent: 0 };

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron-secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
});

async function callGET(authHeader?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/sponsor-burn", {
    method: "GET",
    headers: authHeader ? new Headers({ authorization: authHeader }) : new Headers(),
  });
  return GET(req);
}

async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/sponsor-burn", { method: "POST" });
  return POST(req);
}

describe("GET /api/sponsor-burn (Vercel cron)", () => {
  it("401 when Authorization header is missing", async () => {
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("401 when token is wrong", async () => {
    const res = await callGET("Bearer wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns burned:0 with message when no campaigns due today", async () => {
    // ALTER TABLE + cron CREATE + cron INSERT + SELECT campaigns empty + cron UPDATE
    fake.results = [[], [], [], [], []];
    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { burned: number; message: string };
    expect(body.burned).toBe(0);
    expect(body.message).toContain("No campaigns");
  });

  it("burns campaigns and returns results", async () => {
    fake.results = [
      [],         // ALTER TABLE
      [],         // cron_runs CREATE TABLE
      [],         // cron_runs INSERT running
      [CAMPAIGN], // SELECT campaigns
      [SPONSOR],  // SELECT sponsors
      [],         // UPDATE sponsors
      [],         // UPDATE ad_campaigns last_burn_at
      [],         // cron_runs UPDATE ok
    ];
    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { burned: number; results: { brand: string }[] };
    expect(body.burned).toBe(1);
    expect(body.results![0]!.brand).toBe("AcmeCorp");
  });

  it("skips campaign when no matching sponsor found", async () => {
    fake.results = [
      [],         // ALTER TABLE
      [],         // cron CREATE
      [],         // cron INSERT
      [CAMPAIGN], // SELECT campaigns
      [],         // SELECT sponsors — no match
      [],         // cron UPDATE ok
    ];
    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { burned: number };
    expect(body.burned).toBe(0);
  });

  it("includes _cron_run_id in response", async () => {
    fake.results = [[], [], [], [], []];
    const res = await callGET("Bearer test-cron-secret");
    const body = (await res.json()) as { _cron_run_id: string };
    expect(typeof body._cron_run_id).toBe("string");
  });
});

describe("POST /api/sponsor-burn (admin manual trigger)", () => {
  it("401 when not admin authenticated", async () => {
    mockIsAdmin = false;
    const res = await callPOST();
    expect(res.status).toBe(401);
  });

  it("runs burn when admin authenticated", async () => {
    mockIsAdmin = true;
    fake.results = [[], []]; // ALTER TABLE + SELECT campaigns (empty)
    const res = await callPOST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { burned: number };
    expect(body.burned).toBe(0);
  });
});

describe("burn rate calculation", () => {
  it("dailyRate = totalInvestment / duration_days, catches up missed days", async () => {
    // totalInvestment=700, duration=7 → dailyRate=100; 3 days missed → burn=300; newBalance=400
    mockIsAdmin = true;
    fake.results = [
      [],         // ALTER TABLE
      [CAMPAIGN], // SELECT campaigns
      [SPONSOR],  // SELECT sponsors
      [],         // UPDATE sponsors
      [],         // UPDATE ad_campaigns
    ];
    const res = await callPOST();
    const body = (await res.json()) as { results: { dailyRate: number; newBalance: number }[] };
    expect(body.results![0]!.dailyRate).toBe(300);
    expect(body.results![0]!.newBalance).toBe(400);
  });

  it("caps burn at available balance and marks expired", async () => {
    // glitch_balance=50, total_spent=650 → totalInvestment=700, dailyRate=100
    // 3 days missed → totalBurn=300, but burnAmount=min(300,50)=50, newBalance=0
    const poorSponsor = { id: 2, glitch_balance: 50, total_spent: 650 };
    mockIsAdmin = true;
    fake.results = [
      [],            // ALTER TABLE
      [CAMPAIGN],    // SELECT campaigns
      [poorSponsor], // SELECT sponsors
      [],            // UPDATE sponsors
      [],            // UPDATE ad_campaigns last_burn_at
      [],            // UPDATE ad_campaigns status=completed
    ];
    const res = await callPOST();
    const body = (await res.json()) as { results: { newBalance: number; expired: boolean }[] };
    expect(body.results![0]!.newBalance).toBe(0);
    expect(body.results![0]!.expired).toBe(true);
  });
});
