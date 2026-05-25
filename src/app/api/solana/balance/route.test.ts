/**
 * Tests for /api/solana/balance — full-parity port of legacy
 * `?action=balance`. Covers:
 *   - 400 on missing/invalid wallet_address
 *   - Helius success path returns all four balances + envelope fields
 *   - app_glitch overlay via session_id (DB max-merge)
 *   - Helius unreachable returns zeros + helius_enabled flag stays honest
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

const VALID_WALLET = "9xQeWvG816bUx9EPjHmaT2gvVMPDtMXfBgRtFqcWvDfP";

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.HELIUS_API_KEY = "test-key";
  process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";
  process.env.NEXT_PUBLIC_BUDJU_TOKEN_MINT = "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump";
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DATABASE_URL;
  delete process.env.HELIUS_API_KEY;
});

async function callGet(query: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/solana/balance${query}`));
}

function mockHelius(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      json: async () => body,
    })),
  );
}

describe("GET /api/solana/balance", () => {
  it("400 when wallet_address missing", async () => {
    const res = await callGet("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing/);
  });

  it("400 when wallet_address is malformed", async () => {
    const res = await callGet("?wallet_address=not-a-wallet");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid/);
  });

  it("returns parity shape on Helius success", async () => {
    mockHelius({
      nativeBalance: 2_500_000_000, // 2.5 SOL in lamports
      tokens: [
        {
          mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
          amount: 1_000_000_000_000,
          decimals: 9,
          tokenAccount: "x",
        },
        {
          mint: "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump",
          amount: 5_000_000,
          decimals: 6,
          tokenAccount: "y",
        },
        {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: 12_345_678,
          decimals: 6,
          tokenAccount: "z",
        },
      ],
    });

    const res = await callGet(`?wallet_address=${VALID_WALLET}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      real_mode: true,
      helius_enabled: true,
      wallet_address: VALID_WALLET,
      sol_balance: 2.5,
      glitch_balance: 1000,
      onchain_glitch_balance: 1000,
      app_glitch_balance: 0,
      budju_balance: 5,
      usdc_balance: 12.345678,
      token_mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
    });
  });

  it("merges app-side §GLITCH balance via session_id (max)", async () => {
    mockHelius({
      nativeBalance: 0,
      tokens: [
        {
          mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
          amount: 100_000_000_000, // 100 §GLITCH on-chain
          decimals: 9,
          tokenAccount: "x",
        },
      ],
    });
    fake.results = [[{ balance: 500 }]]; // app side has more

    const res = await callGet(`?wallet_address=${VALID_WALLET}&session_id=sess-1`);
    const body = await res.json();

    expect(body.onchain_glitch_balance).toBe(100);
    expect(body.app_glitch_balance).toBe(500);
    expect(body.glitch_balance).toBe(500); // max(on-chain, app)
  });

  it("returns zeros when Helius unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));

    const res = await callGet(`?wallet_address=${VALID_WALLET}`);
    const body = await res.json();

    expect(body.sol_balance).toBe(0);
    expect(body.glitch_balance).toBe(0);
    expect(body.budju_balance).toBe(0);
    expect(body.usdc_balance).toBe(0);
    expect(body.helius_enabled).toBe(true);
  });
});
