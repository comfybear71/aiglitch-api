/**
 * Smoke tests for /api/wallet — simulated wallet ledger.
 *
 * Pins the action router shape (stats / price_history / create / send /
 * faucet) and the ElonBot transfer block. The full balance + history
 * mutation logic is verified during devnet smoke tests; here we cover
 * auth/input gates and the shape of the response envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

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
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/wallet${query}`, init);
}

describe("GET /api/wallet", () => {
  it("?action=stats returns full blockchain stats envelope", async () => {
    fake.results = [
      [
        { key: "glitch_price_sol", value: "0.0001" },
        { key: "glitch_price_usd", value: "0.02" },
        { key: "glitch_market_cap", value: "2000000" },
        { key: "glitch_total_supply", value: "100000000" },
      ],
      [{ count: 5 }],
      [{ count: 12 }],
      [],
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.price_sol).toBeCloseTo(0.0001);
    expect(body.token_symbol).toBe("§GLITCH");
    expect(body.total_wallets).toBe(5);
  });

  it("?action=price_history synthesises fake series when DB is empty", async () => {
    fake.results = [[]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=price_history"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(168);
  });

  it("400 when no session_id and no recognised action", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(400);
  });
});

describe("POST /api/wallet", () => {
  it("400 without session_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "create_wallet" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("send blocks ElonBot → non-admin transfers", async () => {
    // Send action queries in order:
    //   1. senderWallet (must have wallet_address + sol_balance)
    //   2. coinRows (glitch balance >= amount)
    //   3. recipientWallet (must exist)
    //   4. THEN isElonBotTransferAllowed runs and 403s
    fake.results = [
      [{ wallet_address: "6VAcB1VvZDgJ54XvkYwmtVLweq8NN8TZdgBV3EPzY6gH", sol_balance: 1 }],
      [{ balance: 9999 }],
      [{ owner_type: "human", owner_id: "other-session" }],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "send",
          to_address: "AnyOtherWalletAddr11111111111111111111111111",
          amount: 1,
          token: "GLITCH",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/ElonBot|Technoking|admin/i);
  });
});
