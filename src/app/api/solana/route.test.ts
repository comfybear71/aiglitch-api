/**
 * Smoke tests for /api/solana — action-routed Solana proxy.
 *
 * Pins the action router shape + a couple of pure-function gates:
 *   - GET ?action=mode returns tokenomics envelope
 *   - GET ?action=elonbot_status returns persona metadata
 *   - POST link_phantom validates the address shape
 *   - POST validate_transfer enforces the ElonBot sell restriction
 *
 * Heavy on-chain branches (Helius enhanced API, parsed token accounts)
 * are deferred to devnet smoke tests — the relevant helpers are private
 * to the module and exercised only when a wallet address is supplied.
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
  return new NextRequest(`http://localhost/api/solana${query}`, init);
}

describe("GET /api/solana", () => {
  it("?action=mode returns tokenomics + token mint envelope", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=mode"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("real_mode");
    expect(body).toHaveProperty("token_mint");
    expect(body.tokenomics.total_supply).toBe(100_000_000);
    expect(body.tokenomics.elonbot_allocation).toBe(42_069_000);
  });

  it("?action=elonbot_status returns persona metadata", async () => {
    fake.results = [
      [{ wallet_address: "elon-wallet", sol_balance: "1", glitch_token_balance: "42069000" }],
      [{ balance: "100", lifetime_earned: "100" }],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=elonbot_status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persona_id).toBe("glitch-047");
    expect(body.sell_restriction).toBe("admin_only");
    expect(body.simulated_wallet.address).toBe("elon-wallet");
  });

  it("400 on unknown action", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=banana"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/solana", () => {
  it("400 without session_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "link_phantom" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("link_phantom rejects invalid Solana address", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "link_phantom",
          wallet_address: "not-a-real-pubkey",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("validate_transfer blocks ElonBot → non-admin", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "validate_transfer",
          from_wallet: "6VAcB1VvZDgJ54XvkYwmtVLweq8NN8TZdgBV3EPzY6gH", // ELONBOT
          to_wallet: "AnyOtherWallet1111111111111111111111111111111",
          amount: 1,
        }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.elonbot_restriction).toBe(true);
  });

  it("validate_transfer allows ElonBot → admin", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "validate_transfer",
          from_wallet: "6VAcB1VvZDgJ54XvkYwmtVLweq8NN8TZdgBV3EPzY6gH",
          to_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ", // admin
          amount: 1,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(true);
  });
});
