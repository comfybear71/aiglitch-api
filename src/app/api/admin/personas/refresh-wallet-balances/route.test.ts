/**
 * Tests for /api/admin/personas/refresh-wallet-balances.
 *
 * Covers auth gating, GET listing shape, POST single-persona happy path +
 * 404 (no wallet) + 400 (invalid address), POST batch mode with mixed
 * success/failure, "missing ATA" handling (returns 0, not an error).
 *
 * Solana RPC is mocked at the @solana/web3.js + @solana/spl-token boundary.
 * The route's own DB + branching logic gets exercised end-to-end; we don't
 * sleep on the real `BATCH_THROTTLE_MS` (vi.useFakeTimers handles it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
  throwOnUpdate: false,
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  // Detect the UPDATE statement to optionally throw — covers the
  // "db_write_failed" status branch.
  if (fake.throwOnUpdate && strings.raw.join("").includes("UPDATE budju_wallets")) {
    return Promise.reject(new Error("simulated db failure"));
  }
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));

// Solana mocks — covered at the lib boundary so route.ts is unchanged.
const mockGetBalance = vi.fn();
const mockGetTokenAccountBalance = vi.fn();
const mockGetAssociatedTokenAddress = vi.fn();

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    // PublicKey + LAMPORTS_PER_SOL stay real so address validation works.
  };
});

vi.mock("@/lib/solana-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana-config")>(
    "@/lib/solana-config",
  );
  return {
    ...actual,
    getServerSolanaConnection: () => ({
      getBalance: mockGetBalance,
      getTokenAccountBalance: mockGetTokenAccountBalance,
    }),
  };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: mockGetAssociatedTokenAddress,
}));

const VALID_WALLET = "9xQeWvG816bUx9EPjHmaT2gvVMPDtMXfBgRtFqcWvDfP";
const VALID_WALLET_2 = "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnUpdate = false;
  mockGetBalance.mockReset();
  mockGetTokenAccountBalance.mockReset();
  mockGetAssociatedTokenAddress.mockReset();
  // Default mock — ATA returns a fake pubkey-ish; tests override per case.
  mockGetAssociatedTokenAddress.mockResolvedValue({ toBase58: () => "ata" });
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function buildRequest(init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(
    "http://localhost/api/admin/personas/refresh-wallet-balances",
    init,
  );
}

describe("GET — list eligible personas", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
  });

  it("returns personas + wallet addresses, no private keys", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[
      {
        id: "p1",
        username: "alice",
        display_name: "Alice",
        avatar_emoji: "🦊",
        wallet_address: VALID_WALLET,
      },
      {
        id: "p2",
        username: "bob",
        display_name: "Bob",
        avatar_emoji: null,
        wallet_address: VALID_WALLET_2,
      },
    ]];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.personas).toHaveLength(2);
    expect(body.personas[0].wallet_address).toBe(VALID_WALLET);
    // Critical: response shape excludes any secret-key column even if the
    // query joined it. We assert by checking the exact shape we expect.
    expect(Object.keys(body.personas[0])).toEqual([
      "id", "username", "display_name", "avatar_emoji", "wallet_address",
    ]);
  });
});

describe("POST — single persona refresh", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("404 when persona has no active wallet", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[]]; // SELECT wallet → empty

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("no_wallet");
  });

  it("400 when wallet address is malformed", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ wallet_address: "garbage", username: "alice" }],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("invalid_address");
  });

  it("happy path: pulls SOL + 3 SPL token balances + writes DB", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ wallet_address: VALID_WALLET, username: "alice" }],
      [], // UPDATE
    ];
    mockGetBalance.mockResolvedValue(2_500_000_000); // 2.5 SOL in lamports
    mockGetTokenAccountBalance
      .mockResolvedValueOnce({ value: { uiAmount: 100 } })   // BUDJU
      .mockResolvedValueOnce({ value: { uiAmount: 50.25 } }) // USDC
      .mockResolvedValueOnce({ value: { uiAmount: 7000 } }); // GLITCH

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.balances).toEqual({
      sol: 2.5,
      budju: 100,
      usdc: 50.25,
      glitch: 7000,
    });
    expect(body.rpc_errors).toEqual([]);
  });

  it("missing-ATA error reads as 0, not an rpc_error", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ wallet_address: VALID_WALLET, username: "alice" }],
      [], // UPDATE
    ];
    mockGetBalance.mockResolvedValue(0);
    mockGetTokenAccountBalance
      .mockRejectedValueOnce(new Error("could not find account"))
      .mockRejectedValueOnce(new Error("Invalid param"))
      .mockResolvedValueOnce({ value: { uiAmount: 1 } });

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    const body = await res.json();

    expect(body.balances).toEqual({ sol: 0, budju: 0, usdc: 0, glitch: 1 });
    expect(body.rpc_errors).toEqual([]); // missing-ATA stays silent
  });

  it("unexpected RPC error surfaces into rpc_errors", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ wallet_address: VALID_WALLET, username: "alice" }],
      [],
    ];
    mockGetBalance.mockRejectedValue(new Error("RPC down"));
    mockGetTokenAccountBalance.mockResolvedValue({ value: { uiAmount: 1 } });

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    const body = await res.json();

    expect(body.balances.sol).toBe(0);
    expect(body.rpc_errors[0]).toMatch(/SOL.*RPC down/);
  });

  it("db_write_failed surfaces a 500 when UPDATE throws", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ wallet_address: VALID_WALLET, username: "alice" }],
    ];
    fake.throwOnUpdate = true;
    mockGetBalance.mockResolvedValue(0);
    mockGetTokenAccountBalance.mockResolvedValue({ value: { uiAmount: 0 } });

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("db_write_failed");
  });
});

describe("POST — batch refresh all personas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes every active wallet and tallies updated/failed", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      // SELECT wallets (batch)
      [
        { persona_id: "p1", wallet_address: VALID_WALLET, username: "alice" },
        { persona_id: "p2", wallet_address: "garbage", username: "bob" }, // invalid
        { persona_id: "p3", wallet_address: VALID_WALLET_2, username: "carol" },
      ],
      // UPDATE p1
      [],
      // UPDATE p3 (p2 was invalid, no UPDATE)
      [],
    ];
    mockGetBalance.mockResolvedValue(1_000_000_000); // 1 SOL each
    mockGetTokenAccountBalance.mockResolvedValue({ value: { uiAmount: 0 } });

    const { POST } = await import("./route");
    const resPromise = POST(await buildRequest({ method: "POST", body: "{}" }));

    // Advance through the per-wallet throttles
    await vi.advanceTimersByTimeAsync(1000);

    const res = await resPromise;
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.updated).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results).toHaveLength(3);
    expect(body.results[1].status).toBe("failed");
    expect(body.results[1].error).toMatch(/Invalid address/);
  });
});
