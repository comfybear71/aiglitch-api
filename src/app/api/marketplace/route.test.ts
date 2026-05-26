/**
 * Smoke tests for /api/marketplace.
 *
 * Strategy: pin the input gates + auth/treasury 503 path + cancel
 * cleanup. The full atomic NFT purchase transaction (with real on-
 * chain SPL transfer + mint + metadata) lives in @/lib/nft-mint and
 * is the responsibility of devnet smoke tests, not unit tests.
 *
 * We mock the nft-mint helpers + getServerSolanaConnection at the
 * import level so the route's branches are exercised without
 * touching Solana RPC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/marketplace", () => ({
  getProductById: vi.fn(),
}));
vi.mock("@/lib/nft-mint", () => ({
  buildNftPurchaseTransaction: vi.fn(),
  parseCoinPrice: (s: string) => Number(s.replace(/[^0-9.]/g, "")),
  getRarity: () => "common",
  rarityColor: () => "#888",
}));
vi.mock("@/lib/solana-config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/solana-config");
  return {
    ...actual,
    getServerSolanaConnection: () => ({
      getBalance: vi.fn().mockResolvedValue(50_000_000),
      sendRawTransaction: vi.fn(),
      getLatestBlockhash: vi.fn(),
      confirmTransaction: vi.fn(),
    }),
  };
});

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.TREASURY_PRIVATE_KEY;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/marketplace${query}`, init);
}

describe("GET", () => {
  it("returns empty purchases when no session_id", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchases).toEqual([]);
  });

  it("returns purchases list for a session", async () => {
    fake.results = [
      [{ phantom_wallet_address: null }], // human_users lookup (no wallet)
      [{ product_id: "p1", product_name: "Crown", price_paid: 100 }],
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?session_id=s1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0].product_id).toBe("p1");
  });
});

describe("POST create_purchase", () => {
  it("400 on missing required fields", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "create_purchase", session_id: "s1" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid Solana wallet", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "create_purchase",
          session_id: "s1",
          product_id: "p1",
          buyer_wallet: "not-a-pubkey",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when product not found", async () => {
    const { getProductById } = await import("@/lib/marketplace");
    (getProductById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "create_purchase",
          session_id: "s1",
          product_id: "no-such",
          buyer_wallet: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("409 already-owned when session already purchased product", async () => {
    const { getProductById } = await import("@/lib/marketplace");
    (getProductById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "p1",
      name: "Crown",
      emoji: "👑",
      price: "100 §GLITCH",
    });
    fake.results = [[{ id: "existing-purchase" }]]; // existing purchase row

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "create_purchase",
          session_id: "s1",
          product_id: "p1",
          buyer_wallet: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.already_owned).toBe(true);
  });

  it("503 when TREASURY_PRIVATE_KEY is unset", async () => {
    const { getProductById } = await import("@/lib/marketplace");
    (getProductById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "p1",
      name: "Crown",
      emoji: "👑",
      price: "100 §GLITCH",
    });
    // No existing purchase + supply has room (mintedInGen=0 < 100)
    fake.results = [[], [{ minted: 0, current_gen: 1 }], [{ cnt: 0 }]];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "create_purchase",
          session_id: "s1",
          product_id: "p1",
          buyer_wallet: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
        }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.setup_needed).toBe(true);
  });
});

describe("POST cancel_purchase", () => {
  it("deletes pending purchase + nft rows", async () => {
    fake.results = [[], []];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "cancel_purchase",
          purchase_id: "p-1",
          nft_id: "n-1",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Ensure both DELETE calls fired
    const deleteCalls = fake.calls.filter((c) => c.strings.join("").includes("DELETE"));
    expect(deleteCalls.length).toBe(2);
  });
});

it("400 on unknown POST action", async () => {
  const { POST } = await import("./route");
  const res = await POST(
    await buildRequest("", {
      method: "POST",
      body: JSON.stringify({ action: "banana" }),
    }),
  );
  expect(res.status).toBe(400);
});
