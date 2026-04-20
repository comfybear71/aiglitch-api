/**
 * Integration tests for GET /api/personas/[id]/wallet-balance.
 *
 * - 404 when the persona doesn't exist
 * - Returns the full shape when persona + wallet both exist
 * - `wallet_address: null` when persona has no wallet yet
 * - Cache-Control: public, s-maxage=30, SWR=300
 * - 500 wrapping on DB error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
  throwOnNextCall: Error | null;
}

const fake: FakeNeon = { calls: [], results: [], throwOnNextCall: null };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  if (fake.throwOnNextCall) {
    const err = fake.throwOnNextCall;
    fake.throwOnNextCall = null;
    return Promise.reject(err);
  }
  fake.calls.push({ strings, values });
  const next = fake.results.shift() ?? [];
  return Promise.resolve(next);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnNextCall = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGet(id: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/personas/${id}/wallet-balance`,
  );
  return GET(req, { params: Promise.resolve({ id }) });
}

describe("GET /api/personas/[id]/wallet-balance", () => {
  it("404 when lookup returns no rows", async () => {
    fake.results = [[]];
    const res = await callGet("ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Persona not found");
  });

  it("returns full shape when persona + wallet both exist", async () => {
    fake.results = [
      [
        {
          persona_id: "glitch-042",
          wallet_address: "Phantom111111111111111111111111111",
          glitch_coins: 2500,
          glitch_lifetime_earned: 5000,
          sol_balance: 0.42,
          budju_balance: 0,
          usdc_balance: 10,
          glitch_token_balance: 100000,
        },
      ],
    ];
    const res = await callGet("glitch-042");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona_id: string;
      wallet_address: string | null;
      glitch_coins: number;
      sol_balance: number;
      glitch_token_balance: number;
    };
    expect(body.persona_id).toBe("glitch-042");
    expect(body.wallet_address).toBe("Phantom111111111111111111111111111");
    expect(body.glitch_coins).toBe(2500);
    expect(body.sol_balance).toBe(0.42);
    expect(body.glitch_token_balance).toBe(100000);
  });

  it("returns wallet_address: null when persona has no wallet row", async () => {
    fake.results = [
      [
        {
          persona_id: "glitch-100",
          wallet_address: null,
          glitch_coins: 0,
          glitch_lifetime_earned: 0,
          sol_balance: 0,
          budju_balance: 0,
          usdc_balance: 0,
          glitch_token_balance: 0,
        },
      ],
    ];
    const res = await callGet("glitch-100");
    const body = (await res.json()) as { wallet_address: string | null };
    expect(body.wallet_address).toBeNull();
  });

  it("Cache-Control is public, s-maxage=30, SWR=300", async () => {
    fake.results = [
      [
        {
          persona_id: "glitch-1",
          wallet_address: null,
          glitch_coins: 0,
          glitch_lifetime_earned: 0,
          sol_balance: 0,
          budju_balance: 0,
          usdc_balance: 0,
          glitch_token_balance: 0,
        },
      ],
    ];
    const res = await callGet("glitch-1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );
  });

  it("SQL joins ai_personas → budju_wallets + ai_persona_coins", async () => {
    fake.results = [[]];
    await callGet("glitch-1");
    const sql = fake.calls[0]!.strings.join("?");
    expect(sql).toContain("FROM ai_personas p");
    expect(sql).toContain("LEFT JOIN budju_wallets bw");
    expect(sql).toContain("LEFT JOIN ai_persona_coins apc");
    expect(sql).toContain("WHERE p.id =");
    expect(sql).toContain("LIMIT 1");
  });

  it("500 wrapping on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("glitch-1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load wallet balance");
    expect(body.detail).toBe("pg down");
  });
});
