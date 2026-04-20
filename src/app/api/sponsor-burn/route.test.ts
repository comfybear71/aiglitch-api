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

const SPONSOR_ROWS = [
  { id: "s-1", glitch_balance: 500 },
  { id: "s-2", glitch_balance: 50 }, // will hit 0 and be suspended
];

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron-secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
});

async function callPOST(authHeader?: string) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = authHeader
    ? { authorization: authHeader }
    : {};
  const req = new NextRequest("http://localhost/api/sponsor-burn", {
    method: "POST",
    headers: new Headers(headers),
  });
  return POST(req);
}

describe("POST /api/sponsor-burn", () => {
  it("401 when Authorization header is missing", async () => {
    const res = await callPOST();
    expect(res.status).toBe(401);
  });

  it("401 when token is wrong", async () => {
    const res = await callPOST("Bearer wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns processed count on happy path", async () => {
    // CREATE TABLE + INSERT (cron_runs) + SELECT sponsors + UPDATE s-1 + UPDATE s-2 + UPDATE (cron_runs ok)
    fake.results = [
      [],             // CREATE TABLE IF NOT EXISTS
      [],             // INSERT cron_runs (running)
      SPONSOR_ROWS,   // SELECT sponsors
      [],             // UPDATE s-1
      [],             // UPDATE s-2
      [],             // UPDATE cron_runs (ok)
    ];
    const res = await callPOST("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; suspended: number };
    expect(body.processed).toBe(2);
    expect(body.suspended).toBe(1); // s-2 had balance 50 < DAILY_BURN=100
  });

  it("returns zeros when no active sponsors with balance", async () => {
    fake.results = [
      [],   // CREATE TABLE
      [],   // INSERT cron_runs
      [],   // SELECT sponsors — empty
      [],   // UPDATE cron_runs (ok)
    ];
    const res = await callPOST("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; suspended: number };
    expect(body.processed).toBe(0);
    expect(body.suspended).toBe(0);
  });

  it("includes _cron_run_id in the response", async () => {
    fake.results = [[], [], [], []];
    const res = await callPOST("Bearer test-cron-secret");
    const body = (await res.json()) as { _cron_run_id: string };
    expect(typeof body._cron_run_id).toBe("string");
  });
});
