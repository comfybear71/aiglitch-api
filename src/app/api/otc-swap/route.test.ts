/**
 * Tests for /api/otc-swap — REAL on-chain treasury → buyer SPL transfers.
 *
 * Defensive coverage focused on the high-risk paths:
 *   - Auth/validation gates (wallet shape, amount range, rate limit, daily cap)
 *   - Treasury env-key drift guard (keypair must derive to TREASURY_WALLET_STR)
 *   - Swap expiry (>120s rejects the buyer's signed-tx submission)
 *   - Idempotency (already-completed swap can't be re-confirmed into bad state)
 *
 * Real on-chain calls are mocked at the Connection boundary. Devnet smoke
 * is the user's job — these tests verify the SAFE behavior of the code,
 * not the chain itself.
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

// Solana connection mocks. FAKE_BLOCKHASH = 32 bytes (valid base58).
// FAKE_TX_SIG = 88 chars of '1' — passes the route's regex
// `/^[1-9A-HJ-NP-Za-km-z]{86,90}$/` and isn't used for actual byte
// decoding (sendRawTransaction is mocked so we just need the regex
// to accept it on the confirm_swap path).
const FAKE_BLOCKHASH = "11111111111111111111111111111111";
const FAKE_TX_SIG = "1".repeat(88);

const mockGetAccountInfo = vi.fn();
const mockGetTokenAccountBalance = vi.fn();
const mockGetLatestBlockhash = vi.fn(async () => ({
  blockhash: FAKE_BLOCKHASH,
  lastValidBlockHeight: 1234,
}));
const mockSendRawTransaction = vi.fn(async () => FAKE_TX_SIG);
const mockConfirmTransaction = vi.fn(async () => ({ value: { err: null } }));
const mockGetTransaction = vi.fn();

vi.mock("@/lib/solana-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana-config")>(
    "@/lib/solana-config",
  );
  return {
    ...actual,
    getServerSolanaConnection: () => ({
      getAccountInfo: mockGetAccountInfo,
      getTokenAccountBalance: mockGetTokenAccountBalance,
      getLatestBlockhash: mockGetLatestBlockhash,
      sendRawTransaction: mockSendRawTransaction,
      confirmTransaction: mockConfirmTransaction,
      getTransaction: mockGetTransaction,
    }),
  };
});

const VALID_WALLET = "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";
const VALID_UUID   = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockGetAccountInfo.mockReset();
  mockGetTokenAccountBalance.mockReset();
  mockGetLatestBlockhash.mockClear();
  mockSendRawTransaction.mockClear();
  mockConfirmTransaction.mockClear();
  mockGetTransaction.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  process.env.NEXT_PUBLIC_TREASURY_WALLET = "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56";
  process.env.NEXT_PUBLIC_ADMIN_WALLET = "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";
  process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";
  delete process.env.TREASURY_PRIVATE_KEY;
  delete process.env.ADMIN_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.TREASURY_PRIVATE_KEY;
  delete process.env.ADMIN_TOKEN;
});

async function callPost(body: Record<string, unknown>, headers?: Record<string, string>) {
  vi.resetModules();
  const mod = await import("./route");
  mod.__resetOtcRateLimit();
  const { NextRequest } = await import("next/server");
  return mod.POST(
    new NextRequest("http://localhost/api/otc-swap", {
      method: "POST",
      headers: headers ?? {},
      body: JSON.stringify(body),
    }),
  );
}

async function callGet(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/otc-swap${query}`));
}

describe("GET /api/otc-swap", () => {
  it("?action=config returns bonding curve + supply + limits", async () => {
    fake.results = [
      [],                              // UPDATE cleanup of stale pending
      [{ value: "164" }],              // sol price
      [{ total: 5, glitch_sold: 50000, sol_received: 0.025 }],
    ];
    mockGetAccountInfo.mockResolvedValue({ owner: { equals: () => false } });
    // findTokenAccountForMint will iterate token programs and try to find ATA;
    // we just return null for the inner ATA info so it falls back to default supply.
    mockGetAccountInfo.mockResolvedValueOnce({ owner: { equals: () => false } }); // mint exists
    mockGetAccountInfo.mockResolvedValue(null); // ATA doesn't exist

    const res = await callGet("?action=config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.min_purchase).toBe(100);
    expect(body.max_purchase).toBe(1_000_000);
    expect(body.bonding_curve).toBeTruthy();
    expect(body.bonding_curve.tier).toBe(5);            // 50000 / 10000 = 5
    expect(body.enabled).toBe(false);                    // no TREASURY_PRIVATE_KEY
  });

  it("?action=history requires wallet param", async () => {
    const res = await callGet("?action=history");
    expect(res.status).toBe(400);
  });

  it("?action=history returns swaps for the wallet", async () => {
    fake.results = [[{ id: "s1", glitch_amount: 1000, sol_cost: 0.005, status: "completed" }]];
    const res = await callGet(`?action=history&wallet=${VALID_WALLET}`);
    const body = await res.json();
    expect(body.swaps).toHaveLength(1);
  });

  it("unknown action returns 400", async () => {
    const res = await callGet("?action=banana");
    expect(res.status).toBe(400);
  });
});

describe("POST create_swap — validation gates", () => {
  it("400 missing buyer_wallet", async () => {
    const res = await callPost({ action: "create_swap", glitch_amount: 1000 });
    expect(res.status).toBe(400);
  });

  it("400 invalid wallet shape", async () => {
    const res = await callPost({
      action: "create_swap",
      buyer_wallet: "not-a-wallet",
      glitch_amount: 1000,
    });
    expect(res.status).toBe(400);
  });

  it("400 below min purchase (100)", async () => {
    const res = await callPost({
      action: "create_swap",
      buyer_wallet: VALID_WALLET,
      glitch_amount: 50,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Minimum purchase/);
  });

  it("400 above max purchase (1,000,000)", async () => {
    const res = await callPost({
      action: "create_swap",
      buyer_wallet: VALID_WALLET,
      glitch_amount: 9_999_999,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Maximum purchase/);
  });

  it("429 when daily SOL spend cap exceeded", async () => {
    fake.results = [
      [{ total_sol: 0.6 }], // already spent > 0.5 SOL today
    ];

    const res = await callPost({
      action: "create_swap",
      buyer_wallet: VALID_WALLET,
      glitch_amount: 1000,
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Daily limit/);
  });

  it("503 when TREASURY_PRIVATE_KEY not configured", async () => {
    fake.results = [[{ total_sol: 0 }]]; // daily cap fine
    const res = await callPost({
      action: "create_swap",
      buyer_wallet: VALID_WALLET,
      glitch_amount: 1000,
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.setup_needed).toBe(true);
  });

  it("500 'Treasury configuration error' on env-key drift (keypair doesn't match TREASURY_WALLET_STR)", async () => {
    // Set a random treasury key — it WON'T derive to TREASURY_WALLET_STR.
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    process.env.TREASURY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);

    fake.results = [[{ total_sol: 0 }]];

    const res = await callPost({
      action: "create_swap",
      buyer_wallet: VALID_WALLET,
      glitch_amount: 1000,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Treasury configuration error/);
    // Critically: no transaction was built or sent.
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("POST submit_swap", () => {
  it("400 missing fields", async () => {
    const res = await callPost({ action: "submit_swap" });
    expect(res.status).toBe(400);
  });

  it("400 invalid swap_id format", async () => {
    const res = await callPost({
      action: "submit_swap",
      swap_id: "not-a-uuid",
      signed_transaction: "abc",
    });
    expect(res.status).toBe(400);
  });

  it("404 when swap not pending / not found", async () => {
    fake.results = [[]]; // no row
    const res = await callPost({
      action: "submit_swap",
      swap_id: VALID_UUID,
      signed_transaction: "abc",
    });
    expect(res.status).toBe(404);
  });

  it("410 when swap older than 120s", async () => {
    const oldDate = new Date(Date.now() - 200_000).toISOString();
    fake.results = [
      [{ id: VALID_UUID, created_at: oldDate }],
      [], // UPDATE to 'expired'
    ];
    const res = await callPost({
      action: "submit_swap",
      swap_id: VALID_UUID,
      signed_transaction: "abc",
    });
    expect(res.status).toBe(410);
  });
});

describe("POST confirm_swap", () => {
  it("400 missing fields", async () => {
    const res = await callPost({ action: "confirm_swap" });
    expect(res.status).toBe(400);
  });

  it("400 invalid swap_id format", async () => {
    const res = await callPost({
      action: "confirm_swap",
      swap_id: "bad",
      tx_signature: FAKE_TX_SIG,
    });
    expect(res.status).toBe(400);
  });

  it("400 invalid tx_signature shape", async () => {
    const res = await callPost({
      action: "confirm_swap",
      swap_id: VALID_UUID,
      tx_signature: "0OIl-bad",
    });
    expect(res.status).toBe(400);
  });

  it("404 when swap doesn't exist", async () => {
    fake.results = [[]];
    const res = await callPost({
      action: "confirm_swap",
      swap_id: VALID_UUID,
      tx_signature: FAKE_TX_SIG,
    });
    expect(res.status).toBe(404);
  });

  it("idempotent — already-completed swap returns success without re-confirming", async () => {
    fake.results = [[{ id: VALID_UUID, buyer_wallet: VALID_WALLET, status: "completed" }]];
    const res = await callPost({
      action: "confirm_swap",
      swap_id: VALID_UUID,
      tx_signature: FAKE_TX_SIG,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/Already confirmed/);
    // No on-chain calls made
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it("202 when tx not yet on-chain", async () => {
    fake.results = [[{ id: VALID_UUID, buyer_wallet: VALID_WALLET, status: "pending" }]];
    mockGetTransaction.mockResolvedValue(null);

    const res = await callPost({
      action: "confirm_swap",
      swap_id: VALID_UUID,
      tx_signature: FAKE_TX_SIG,
    });
    expect(res.status).toBe(202);
  });

  it("400 + status='failed' when on-chain tx failed", async () => {
    fake.results = [
      [{ id: VALID_UUID, buyer_wallet: VALID_WALLET, status: "pending" }],
      [], // UPDATE to 'failed'
    ];
    mockGetTransaction.mockResolvedValue({
      meta: { err: { InstructionError: [0, "Custom"] } },
    });

    const res = await callPost({
      action: "confirm_swap",
      swap_id: VALID_UUID,
      tx_signature: FAKE_TX_SIG,
    });
    expect(res.status).toBe(400);
  });

  it("happy path marks completed + records tx_signature", async () => {
    fake.results = [
      [{ id: VALID_UUID, buyer_wallet: VALID_WALLET, status: "pending" }],
      [], // UPDATE to 'completed'
    ];
    mockGetTransaction.mockResolvedValue({
      meta: { err: null },
      slot: 100,
    });

    const res = await callPost({
      action: "confirm_swap",
      swap_id: VALID_UUID,
      tx_signature: FAKE_TX_SIG,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tx_signature).toBe(FAKE_TX_SIG);
  });
});

describe("POST set_price (admin)", () => {
  it("403 with no auth", async () => {
    const res = await callPost({ action: "set_price", price_sol: 0.001 });
    expect(res.status).toBe(403);
  });

  it("403 with wrong admin_wallet", async () => {
    const res = await callPost({
      action: "set_price",
      price_sol: 0.001,
      admin_wallet: "GhostWaLLeT",
    });
    expect(res.status).toBe(403);
  });

  it("400 invalid price", async () => {
    const res = await callPost({
      action: "set_price",
      price_sol: -1,
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(400);
  });

  it("happy path with correct admin_wallet", async () => {
    fake.results = [[]];
    const res = await callPost({
      action: "set_price",
      price_sol: 0.001,
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_price_sol).toBe(0.001);
  });

  it("happy path with x-admin-token header", async () => {
    process.env.ADMIN_TOKEN = "secret-token";
    fake.results = [[]];
    const res = await callPost(
      { action: "set_price", price_sol: 0.002 },
      { "x-admin-token": "secret-token" },
    );
    expect(res.status).toBe(200);
  });
});

describe("POST unknown action", () => {
  it("400", async () => {
    const res = await callPost({ action: "banana" });
    expect(res.status).toBe(400);
  });
});
