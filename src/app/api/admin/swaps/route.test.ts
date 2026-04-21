import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/admin/swaps${query}`));
}

describe("GET /api/admin/swaps", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns stats + swaps on happy path", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{
        total_swaps: "10", completed_swaps: "8", pending_swaps: "1", failed_swaps: "1",
        total_sol_volume: "2.5", total_glitch_volume: "50000", avg_price: "0.00005",
      }],
      [
        { id: "sw1", buyer_wallet: "w1", glitch_amount: 1000, sol_cost: 0.5, status: "completed" },
        { id: "sw2", buyer_wallet: "w2", glitch_amount: 500,  sol_cost: 0.25, status: "pending" },
      ],
    ];
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: {
        total_swaps: number;
        completed_swaps: number;
        total_sol_volume: number;
        total_glitch_volume: number;
        avg_price: number;
      };
      swaps: unknown[];
      pagination: { limit: number; offset: number; returned: number };
    };
    expect(body.stats.total_swaps).toBe(10);
    expect(body.stats.completed_swaps).toBe(8);
    expect(body.stats.total_sol_volume).toBe(2.5);
    expect(body.stats.avg_price).toBe(0.00005);
    expect(body.swaps).toHaveLength(2);
    expect(body.pagination.returned).toBe(2);
  });

  it("applies status filter when ?status= provided", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ total_swaps: 0, completed_swaps: 0, pending_swaps: 0, failed_swaps: 0, total_sol_volume: 0, total_glitch_volume: 0, avg_price: 0 }],
      [],
    ];
    await callGET("?status=completed");
    const listCall = fake.calls[1];
    expect(listCall.values).toContain("completed");
  });

  it("clamps limit at MAX_LIMIT (200) and respects offset", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ total_swaps: 0, completed_swaps: 0, pending_swaps: 0, failed_swaps: 0, total_sol_volume: 0, total_glitch_volume: 0, avg_price: 0 }],
      [],
    ];
    await callGET("?limit=999&offset=5");
    const listCall = fake.calls[1];
    expect(listCall.values).toContain(200);  // clamped limit
    expect(listCall.values).toContain(5);
  });

  it("defaults to sensible zeros when otc_swaps is empty", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ total_swaps: 0, completed_swaps: 0, pending_swaps: 0, failed_swaps: 0, total_sol_volume: 0, total_glitch_volume: 0, avg_price: 0 }],
      [],
    ];
    const res = await callGET();
    const body = (await res.json()) as { stats: { total_swaps: number }; swaps: unknown[] };
    expect(body.stats.total_swaps).toBe(0);
    expect(body.swaps).toEqual([]);
  });
});
