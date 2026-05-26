/**
 * Smoke tests for /api/trading — public dashboard data (no auth).
 *
 * Strategy: mock the settings + trading repositories at the import
 * level. The real SQL paths are covered by the repository tests;
 * here we only verify the route correctly fans the parallel reads
 * into the response envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/repositories/settings", () => ({
  getSetting: vi.fn(),
}));

vi.mock("@/lib/repositories/trading", () => ({
  getDashboard: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/trading", () => {
  it("returns price + stats_24h + order_book envelope", async () => {
    const { getSetting } = await import("@/lib/repositories/settings");
    const { getDashboard } = await import("@/lib/repositories/trading");
    const m = getSetting as ReturnType<typeof vi.fn>;
    m.mockResolvedValueOnce("200")          // sol_price_usd
      .mockResolvedValueOnce("0.0001")       // glitch_price_sol
      .mockResolvedValueOnce("0.02");        // glitch_price_usd
    (getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
      stats24h: {
        totalTrades: 7,
        buys: 4,
        sells: 3,
        volumeSol: 1.5,
        volumeGlitch: 15000,
        high: 0.000045,
        low: 0.0000401,
      },
      bids: [{ price: 0.00004, qty: 100 }],
      asks: [{ price: 0.00005, qty: 50 }],
      recentTrades: [{ id: "t1" }],
      priceHistory: [{ t: 1, p: 0.00004 }],
      leaderboard: [{ session_id: "s1", pnl: 12 }],
    });

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.price).toEqual({
      current_sol: 0.0001,
      current_usd: 0.02,
      sol_usd: 200,
    });
    expect(body.stats_24h.total_trades).toBe(7);
    expect(body.order_book.bids[0].price).toBe(0.00004);
    expect(body.recent_trades).toHaveLength(1);
  });

  it("falls back to defaults when settings are missing", async () => {
    const { getSetting } = await import("@/lib/repositories/settings");
    const { getDashboard } = await import("@/lib/repositories/trading");
    (getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
      stats24h: {
        totalTrades: 0, buys: 0, sells: 0,
        volumeSol: 0, volumeGlitch: 0, high: 0, low: 0,
      },
      bids: [], asks: [], recentTrades: [], priceHistory: [], leaderboard: [],
    });

    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(body.price.sol_usd).toBe(164);
    expect(body.price.current_sol).toBeCloseTo(0.000042);
    expect(body.price.current_usd).toBeCloseTo(0.0069);
  });
});
