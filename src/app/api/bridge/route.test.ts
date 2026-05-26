/**
 * Tests for /api/bridge — snapshot → on-chain claim orchestrator.
 *
 * Pure DB ledger. We cover the action-router shape, both happy paths,
 * and the most important defensive branches (already-claimed,
 * pending-claim guard, missing-snapshot, invalid wallet).
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

const VALID_WALLET = "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.NEXT_PUBLIC_SOLANA_REAL_MODE;
  delete process.env.TREASURY_PRIVATE_KEY;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.NEXT_PUBLIC_SOLANA_REAL_MODE;
  delete process.env.TREASURY_PRIVATE_KEY;
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/bridge${query}`, init);
}

describe("GET /api/bridge", () => {
  it("?action=status returns bridge_active=false when no snapshot", async () => {
    fake.results = [[]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=status&session_id=s1"));
    const body = await res.json();
    expect(body.bridge_active).toBe(false);
  });

  it("?action=status returns full envelope when snapshot + entry exist", async () => {
    fake.results = [
      [{ id: "snap-1", name: "Genesis Snapshot", created_at: "2026-05-26T00:00:00Z" }],
      [{ id: "e1", snapshot_id: "snap-1", holder_type: "human", holder_id: "s1", balance: 1000, claim_status: "pending", phantom_wallet: null, claimed_at: null, claim_tx_hash: null }],
      [{ phantom_wallet_address: VALID_WALLET, display_name: "Alice" }],
      [{ balance: 1500 }],
      [],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=status&session_id=s1"));
    const body = await res.json();

    expect(body.bridge_active).toBe(true);
    expect(body.snapshot_balance).toBe(1000);
    expect(body.current_balance).toBe(1500);
    expect(body.phantom_wallet).toBe(VALID_WALLET);
    expect(body.claim_status).toBe("pending");
    expect(body.claim).toBeNull();
    expect(body.token_mint).toBeTruthy();
  });

  it("?action=overview returns aggregated stats", async () => {
    fake.results = [
      [{ id: "snap-1", name: "Genesis", status: "finalized" }],
      [{
        total_entries: 100, human_entries: 80, ai_entries: 20,
        with_wallet: 50, claimed: 30, pending: 20,
        total_supply: 1000000, claimed_supply: 300000,
      }],
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=overview"));
    const body = await res.json();
    expect(body.bridge_active).toBe(true);
    expect(body.stats.total_entries).toBe(100);
    expect(body.stats.claimed).toBe(30);
  });

  it("400 on unknown action", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=banana"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/bridge claim", () => {
  it("400 missing session_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({ action: "claim" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("400 missing wallet_address", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Phantom/);
  });

  it("400 invalid wallet_address shape", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: "bad" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid Solana wallet/);
  });

  it("404 when no snapshot exists", async () => {
    fake.results = [[]]; // snapshot lookup empty
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: VALID_WALLET }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404 when no snapshot entry for this user", async () => {
    fake.results = [
      [{ id: "snap-1" }],
      [],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: VALID_WALLET }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects already-claimed entry with tx_signature", async () => {
    fake.results = [
      [{ id: "snap-1" }],
      [{ id: "e1", snapshot_id: "snap-1", holder_type: "human", holder_id: "s1", balance: 1000, claim_status: "claimed", claim_tx_hash: "tx-sig-123", phantom_wallet: VALID_WALLET, claimed_at: "2026-05-25" }],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: VALID_WALLET }),
      }),
    );
    const body = await res.json();
    expect(body.already_claimed).toBe(true);
    expect(body.tx_signature).toBe("tx-sig-123");
  });

  it("rejects when there's already a pending claim", async () => {
    fake.results = [
      [{ id: "snap-1" }],
      [{ id: "e1", snapshot_id: "snap-1", holder_type: "human", holder_id: "s1", balance: 1000, claim_status: null, claim_tx_hash: null, phantom_wallet: null, claimed_at: null }],
      [{ id: "existing-claim", status: "pending" }],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: VALID_WALLET }),
      }),
    );
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(body.claim_id).toBe("existing-claim");
  });

  it("happy path: marks as 'pending' in simulated mode", async () => {
    fake.results = [
      [{ id: "snap-1" }],
      [{ id: "e1", snapshot_id: "snap-1", holder_type: "human", holder_id: "s1", balance: 5000, claim_status: null, claim_tx_hash: null, phantom_wallet: null, claimed_at: null }],
      [],
      [], // INSERT claim
      [], // UPDATE entry
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: VALID_WALLET }),
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.amount).toBe(5000);
    expect(body.status).toBe("pending");
    expect(body.note).toMatch(/not active/);
  });

  it("happy path: marks as 'queued' in real mode with treasury key", async () => {
    process.env.NEXT_PUBLIC_SOLANA_REAL_MODE = "true";
    process.env.TREASURY_PRIVATE_KEY = "fake-key";
    process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";

    fake.results = [
      [{ id: "snap-1" }],
      [{ id: "e1", snapshot_id: "snap-1", holder_type: "human", holder_id: "s1", balance: 5000, claim_status: null, claim_tx_hash: null, phantom_wallet: null, claimed_at: null }],
      [],
      [], // INSERT
      [], // UPDATE entry
      [], // UPDATE claim → queued
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim", wallet_address: VALID_WALLET }),
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("queued");
  });
});

describe("POST /api/bridge process_claim", () => {
  it("400 when claim_id or tx_signature missing", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "process_claim" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when claim not found", async () => {
    fake.results = [[]];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "process_claim",
          claim_id: "missing",
          tx_signature: "tx",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("happy path marks completed + updates entry", async () => {
    fake.results = [
      [{
        id: "c1", snapshot_id: "snap-1", session_id: "s1",
        phantom_wallet: VALID_WALLET, amount: 5000, status: "pending",
        tx_signature: null, error_message: null, created_at: "2026-05-25", completed_at: null,
      }],
      [],
      [],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "process_claim",
          claim_id: "c1",
          tx_signature: "real-tx",
        }),
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tx_signature).toBe("real-tx");
    expect(body.amount).toBe(5000);
  });
});
