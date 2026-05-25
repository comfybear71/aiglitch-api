/**
 * Tests for /api/admin/nfts.
 *
 * Covers the action-router shape (list / pending / lookup_tx / reconcile /
 * auto_reconcile / assign_by_tx / cleanup_pending). Solana connection
 * methods are mocked at the @solana/web3.js boundary so we exercise the
 * route's own DB + branching logic without touching mainnet.
 *
 * Not unit-testable here: the actual on-chain RPC responses. Those are
 * shaped from the legacy code's expectations + the @solana/web3.js
 * type defs.
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
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));

// Solana connection mock — every route action that hits chain goes through
// getServerSolanaConnection. We stub it to a vi.fn that the test sets per case.
const mockGetTransaction = vi.fn();
const mockGetAccountInfo = vi.fn();
const mockGetSignaturesForAddress = vi.fn();

vi.mock("@/lib/solana-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana-config")>(
    "@/lib/solana-config",
  );
  return {
    ...actual,
    getServerSolanaConnection: () => ({
      getTransaction: mockGetTransaction,
      getAccountInfo: mockGetAccountInfo,
      getSignaturesForAddress: mockGetSignaturesForAddress,
    }),
  };
});

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockGetTransaction.mockReset();
  mockGetAccountInfo.mockReset();
  mockGetSignaturesForAddress.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/admin/nfts${query}`, init);
}

const VALID_MINT = "9xQeWvG816bUx9EPjHmaT2gvVMPDtMXfBgRtFqcWvDfP";
const VALID_TX_SIG = "5J7uH8VLqYpQwR3K2c4N6mF1xA9dD7sG2hT8jL4nB6pE3vY";

describe("GET /api/admin/nfts", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
  });

  it("list returns nfts array with owner info", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[
      {
        id: "nft1",
        product_name: "Cybertruck Skin",
        owner_id: "sess-1",
        mint_tx_hash: VALID_TX_SIG,
        owner_name: "Alice",
        owner_username: "alice",
        owner_emoji: "🔥",
      },
    ]];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=list"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nfts).toHaveLength(1);
    expect(body.nfts[0].owner_name).toBe("Alice");
  });

  it("default action is list when no action param", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nfts).toEqual([]);
  });

  it("pending returns only NFTs with mint_tx_hash='pending'", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[
      { id: "nft2", product_name: "Pending Item", mint_tx_hash: "pending" },
    ]];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=pending"));
    const body = await res.json();
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].mint_tx_hash).toBe("pending");
  });

  it("lookup_tx 400 when tx param missing", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=lookup_tx"));
    expect(res.status).toBe(400);
  });

  it("lookup_tx extracts sig from Solscan URL and finds matching DB row", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    mockGetTransaction.mockResolvedValue({
      slot: 12345,
      blockTime: 1700000000,
      meta: { fee: 5000, err: null },
      transaction: {
        message: {
          getAccountKeys: () => ({
            staticAccountKeys: [{ toBase58: () => "AcCt1" }, { toBase58: () => "AcCt2" }],
          }),
        },
      },
    });
    fake.results = [
      [{ id: "nft1", product_name: "Item", owner_id: "sess-1", mint_tx_hash: VALID_TX_SIG }],
      [],
    ];

    const { GET } = await import("./route");
    const res = await GET(
      await buildRequest(`?action=lookup_tx&tx=https://solscan.io/tx/${VALID_TX_SIG}`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tx_signature).toBe(VALID_TX_SIG);
    expect(body.on_chain.success).toBe(true);
    expect(body.on_chain.slot).toBe(12345);
    expect(body.on_chain.accounts).toEqual(["AcCt1", "AcCt2"]);
    expect(body.db_nft).toMatchObject({ id: "nft1", product_name: "Item" });
    expect(body.db_blockchain_tx).toBeNull();
  });

  it("lookup_tx 404 when tx not on-chain", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    mockGetTransaction.mockResolvedValue(null);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest(`?action=lookup_tx&tx=${VALID_TX_SIG}`));
    expect(res.status).toBe(404);
  });

  it("returns 400 for unknown GET action", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=banana"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/nfts", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
  });

  describe("reconcile", () => {
    it("400 when nft_id or tx_signature missing", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "reconcile", nft_id: "nft1" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("404 when NFT not in DB", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [[]]; // SELECT minted_nfts returns nothing

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "reconcile",
            nft_id: "nft1",
            tx_signature: VALID_TX_SIG,
          }),
        }),
      );
      expect(res.status).toBe(404);
    });

    it("400 when on-chain tx failed", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        [{ id: "nft1", mint_tx_hash: "pending", owner_id: "u", product_name: "X" }],
      ];
      mockGetTransaction.mockResolvedValue({
        slot: 1,
        meta: { fee: 5000, err: { InstructionError: [0, "Custom"] } },
      });

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "reconcile",
            nft_id: "nft1",
            tx_signature: VALID_TX_SIG,
          }),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/failed on-chain/);
    });

    it("happy path updates DB and returns success", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        [{ id: "nft1", mint_tx_hash: "pending", owner_id: "u", product_name: "X" }],
        [], // UPDATE returns nothing
      ];
      mockGetTransaction.mockResolvedValue({
        slot: 100,
        meta: { fee: 5000, err: null },
      });

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "reconcile",
            nft_id: "nft1",
            tx_signature: VALID_TX_SIG,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toMatch(/reconciled/);
    });
  });

  describe("auto_reconcile", () => {
    it("returns reconciled=0 when no pending NFTs", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [[]]; // empty pending set

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "auto_reconcile" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reconciled).toBe(0);
    });

    it("reconciles a pending NFT whose mint exists on-chain", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        // SELECT pending
        [{
          id: "nft1",
          mint_address: VALID_MINT,
          owner_id: "sess-1",
          product_name: "Mint Exists",
          created_at: "2026-05-25T00:00:00Z",
        }],
        // UPDATE minted_nfts
        [],
      ];
      mockGetAccountInfo.mockResolvedValue({ data: Buffer.from("acct") });
      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_TX_SIG, slot: 9999 },
      ]);

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "auto_reconcile" }),
        }),
      );
      const body = await res.json();
      expect(body.reconciled).toBe(1);
      expect(body.results[0].status).toBe("reconciled");
      expect(body.results[0].tx).toBe(VALID_TX_SIG);
    });

    it("flags not_minted_on_chain when account info is null", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        [{
          id: "nft1",
          mint_address: VALID_MINT,
          owner_id: "sess-1",
          product_name: "Phantom NFT",
          created_at: "2026-05-25T00:00:00Z",
        }],
      ];
      mockGetAccountInfo.mockResolvedValue(null);

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "auto_reconcile" }),
        }),
      );
      const body = await res.json();
      expect(body.reconciled).toBe(0);
      expect(body.results[0].status).toBe("not_minted_on_chain");
    });

    it("flags no_mint_address when mint_address is null or 'pending'", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        [{
          id: "nft1",
          mint_address: "pending",
          owner_id: "sess-1",
          product_name: "Stub",
          created_at: "2026-05-25T00:00:00Z",
        }],
      ];

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "auto_reconcile" }),
        }),
      );
      const body = await res.json();
      expect(body.results[0].status).toBe("no_mint_address");
    });
  });

  describe("assign_by_tx", () => {
    it("400 when missing params", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "assign_by_tx" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("404 when no NFT has the tx signature", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [[]];
      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "assign_by_tx",
            tx_signature: VALID_TX_SIG,
            session_id: "sess-1",
          }),
        }),
      );
      expect(res.status).toBe(404);
    });

    it("updates owner when NFT exists", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        [{ id: "nft1" }],
        [],
      ];
      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "assign_by_tx",
            tx_signature: VALID_TX_SIG,
            session_id: "sess-1",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.nft_id).toBe("nft1");
    });
  });

  describe("cleanup_pending", () => {
    it("deletes pending NFTs older than threshold and cleans linked purchases", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [
        // DELETE FROM minted_nfts RETURNING ...
        [
          { id: "nft1", product_name: "Old1", owner_id: "u1" },
          { id: "nft2", product_name: "Old2", owner_id: "u2" },
        ],
        // 2 best-effort purchase deletes (one per orphan)
        [],
        [],
      ];

      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "cleanup_pending", older_than_hours: 24 }),
        }),
      );
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });

    it("returns 0 when no orphans older than threshold", async () => {
      const { isAdminAuthenticated } = await import("@/lib/admin-auth");
      (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      fake.results = [[]];
      const { POST } = await import("./route");
      const res = await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "cleanup_pending" }),
        }),
      );
      const body = await res.json();
      expect(body.deleted).toBe(0);
    });
  });

  it("returns 400 for unknown POST action", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "banana" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
