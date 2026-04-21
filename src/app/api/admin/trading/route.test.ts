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

beforeEach(() => {
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
  return GET(new NextRequest(`http://localhost/api/admin/trading${query}`));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/trading", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("GET /api/admin/trading", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("400 on unknown action", async () => {
    mockIsAdmin = true;
    expect((await callGET("?action=trade_everything")).status).toBe(400);
  });

  it("returns dashboard with defaults when tables are empty/missing", async () => {
    mockIsAdmin = true;
    // All subsequent SELECTs default to [] via fakeSql's fallback
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      price: { current_sol: number; current_usd: number };
      stats_24h: { total_trades: number };
      order_book: { bids: unknown[]; asks: unknown[] };
      recent_trades: unknown[];
      price_history: unknown[];
      leaderboard: unknown[];
      holdings: unknown[];
    };
    // Default price fallback: 0.000042 SOL / 0.0069 USD
    expect(body.price.current_sol).toBe(0.000042);
    expect(body.price.current_usd).toBe(0.0069);
    expect(body.stats_24h.total_trades).toBe(0);
    expect(body.order_book.bids).toEqual([]);
    expect(body.order_book.asks).toEqual([]);
  });

  it("populates price from platform_settings and stats + orderbook from ai_trades", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ value: "0.00005" }],  // glitch_price_sol
      [{ value: "0.0082" }],   // glitch_price_usd
      [{ value: "170" }],      // sol_price_usd
      // recent trades
      [
        { id: "t1", trade_type: "buy", glitch_amount: 100, sol_amount: 0.005, price_per_glitch: 0.00005, commentary: null, strategy: null, created_at: "2026-04-21T00:00:00Z", display_name: "Alpha", avatar_emoji: "🤖", username: "alpha" },
      ],
      // buy orders
      [{ price: "0.00005", total_glitch: "500", total_sol: "0.025", order_count: "2" }],
      // sell orders
      [{ price: "0.00006", total_glitch: "300", total_sol: "0.018", order_count: "1" }],
      // stats 24h
      [{ total_trades: "10", buys: "7", sells: "3", total_volume_sol: "0.5", total_volume_glitch: "10000", avg_price: "0.00005", high_price: "0.00007", low_price: "0.00004" }],
      // price history
      [],
      // leaderboard
      [],
      // holdings
      [],
    ];
    const res = await callGET();
    const body = (await res.json()) as {
      price: { current_sol: number; current_usd: number; sol_usd: number };
      stats_24h: { total_trades: number; buys: number; sells: number };
      order_book: { bids: { price: number; amount: number }[]; asks: { price: number }[] };
      recent_trades: { id: string }[];
    };
    expect(body.price.current_sol).toBe(0.00005);
    expect(body.price.sol_usd).toBe(170);
    expect(body.stats_24h.total_trades).toBe(10);
    expect(body.stats_24h.buys).toBe(7);
    expect(body.order_book.bids[0].price).toBe(0.00005);
    expect(body.order_book.bids[0].amount).toBe(500);
    expect(body.recent_trades).toHaveLength(1);
  });
});

describe("POST /api/admin/trading", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ action: "trigger_trades" })).status).toBe(401);
  });

  it("501 — trigger_trades is intentionally not migrated (Phase 8 locked)", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ action: "trigger_trades", count: 5 });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { migrated: boolean; detail: string };
    expect(body.migrated).toBe(false);
    expect(body.detail).toContain("Phase 8");
  });

  it("501 for any POST action (not just trigger_trades)", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ action: "anything" });
    expect(res.status).toBe(501);
  });
});
