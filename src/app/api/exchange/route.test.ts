/**
 * Tests for /api/exchange — read-only market data + user balances.
 *
 * Covers the action-router shape, balances aggregation across 3 tables,
 * external API fallback chain (DexScreener → Jupiter → stored DB prices),
 * POST 410 behavior. External fetches are mocked so we exercise the
 * branching logic without hitting real DexScreener/Jupiter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
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
  vi.unstubAllGlobals();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/exchange${query}`, init);
}

function stubFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const r = responses[i] ?? { ok: false, body: {} };
      i++;
      return { ok: r.ok, json: async () => r.body };
    }),
  );
}

describe("GET /api/exchange", () => {
  it("?action=pairs returns trading pairs + tokens metadata", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=pairs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.pairs)).toBe(true);
    expect(Array.isArray(body.tokens)).toBe(true);
    expect(body.tokens.length).toBeGreaterThan(0);
    expect(body.tokens[0]).toHaveProperty("symbol");
    expect(body.tokens[0]).toHaveProperty("mintAddress");
  });

  it("?action=balances aggregates from 3 tables", async () => {
    fake.results = [
      [{ balance: 5000 }],          // glitch_coins
      [{ sol_balance: 1.23 }],       // solana_wallets
      [                              // token_balances
        { token: "USDC", balance: 42.5 },
        { token: "BUDJU", balance: 999 },
        { token: "GLITCH", balance: 1 },  // ignored — already from glitch_coins
        { token: "SOL", balance: 1 },     // ignored — already from solana_wallets
      ],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=balances&session_id=s1"));
    const body = await res.json();
    expect(body.balances).toEqual({
      GLITCH: 5000,
      SOL: 1.23,
      USDC: 42.5,
      BUDJU: 999,
    });
  });

  it("?action=history returns exchange_orders for the session", async () => {
    fake.results = [[{ id: "o1", session_id: "s1", pair: "GLITCH_USDC" }]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=history&session_id=s1"));
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
  });

  it("?action=market with invalid pair returns 400", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=market&pair=NOT_A_PAIR"));
    expect(res.status).toBe(400);
  });

  it("market path uses DexScreener data when available", async () => {
    stubFetch([
      // DexScreener for GLITCH
      {
        ok: true,
        body: {
          pairs: [
            {
              chainId: "solana",
              dexId: "meteora",
              pairAddress: "POOL123",
              baseToken: {
                address: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
                name: "AIG!itch",
                symbol: "GLITCH",
              },
              quoteToken: {
                address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                name: "USDC",
                symbol: "USDC",
              },
              priceUsd: "0.00042",
              priceNative: "0.00042",
              priceChange: { m5: 0, h1: 0, h6: 0, h24: 2.5 },
              volume: { m5: 0, h1: 0, h6: 0, h24: 12345 },
              txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 10, sells: 5 } },
              liquidity: { usd: 50000, base: 1000, quote: 50000 },
              fdv: 1000000,
              marketCap: 800000,
            },
          ],
        },
      },
    ]);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=market&pair=GLITCH_USDC"));
    const body = await res.json();

    expect(body.data_source).toBe("dexscreener");
    expect(body.price_usd).toBe(0.00042);
    expect(body.change_24h).toBe(2.5);
    expect(body.pool_address).toBe("POOL123");
    expect(body.dex_name).toBe("meteora");
    expect(body.txns_24h).toEqual({ buys: 10, sells: 5 });
  });

  it("market path falls back to Jupiter when DexScreener empty", async () => {
    stubFetch([
      { ok: true, body: { pairs: [] } }, // DexScreener empty
      // Jupiter for GLITCH
      { ok: true, body: { data: { "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT": { price: "0.00069" } } } },
    ]);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=market&pair=GLITCH_USDC"));
    const body = await res.json();

    expect(body.data_source).toBe("jupiter");
    expect(body.price_usd).toBe(0.00069);
    expect(body.dex_name).toBe("");
  });

  it("market path falls back to stored DB prices when both APIs fail", async () => {
    stubFetch([
      { ok: false, body: {} }, // DexScreener fail
      { ok: false, body: {} }, // Jupiter fail
    ]);
    fake.results = [
      [
        { key: "glitch_price_usd", value: "0.0042" },
        { key: "sol_price_usd", value: "164" },
      ],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=market&pair=GLITCH_USDC"));
    const body = await res.json();

    expect(body.data_source).toBe("stored");
    expect(body.price_usd).toBe(0.0042);
  });

  it("returns 400 for unknown action without sessionId", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=banana"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/exchange", () => {
  it("always returns 410 Gone with redirect hint", async () => {
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toMatch(/Direct trading removed/);
    expect(body.redirect).toBe("/exchange");
  });
});
