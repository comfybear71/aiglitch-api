/**
 * Tests for /api/solana/token-balance — pure on-chain slice. Covers:
 *   - 400 on missing/invalid wallet_address
 *   - 200 flat token shape (no envelope, no DB merge)
 *   - session_id is ignored (no DB call)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls: unknown[] = [];
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  dbCalls.push({ strings, values });
  return Promise.resolve([]);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const VALID_WALLET = "9xQeWvG816bUx9EPjHmaT2gvVMPDtMXfBgRtFqcWvDfP";

beforeEach(() => {
  dbCalls.length = 0;
  process.env.HELIUS_API_KEY = "test-key";
  process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";
  process.env.NEXT_PUBLIC_BUDJU_TOKEN_MINT = "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump";
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HELIUS_API_KEY;
});

async function callGet(query: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/solana/token-balance${query}`));
}

describe("GET /api/solana/token-balance", () => {
  it("400 when wallet_address missing", async () => {
    const res = await callGet("");
    expect(res.status).toBe(400);
  });

  it("400 when wallet_address malformed", async () => {
    const res = await callGet("?wallet_address=bad");
    expect(res.status).toBe(400);
  });

  it("returns flat on-chain token shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          nativeBalance: 1_000_000_000,
          tokens: [
            {
              mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
              amount: 7_000_000_000,
              decimals: 9,
              tokenAccount: "x",
            },
            {
              mint: "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump",
              amount: 2_500_000,
              decimals: 6,
              tokenAccount: "y",
            },
          ],
        }),
      })),
    );

    const res = await callGet(`?wallet_address=${VALID_WALLET}&session_id=ignored`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      wallet_address: VALID_WALLET,
      sol_balance: 1,
      glitch_balance: 7,
      budju_balance: 2.5,
      usdc_balance: 0,
      token_mint: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
    });

    // No envelope fields leak in
    expect(body).not.toHaveProperty("real_mode");
    expect(body).not.toHaveProperty("helius_enabled");
    expect(body).not.toHaveProperty("app_glitch_balance");

    // session_id MUST NOT trigger a DB lookup on this route
    expect(dbCalls).toHaveLength(0);
  });
});
