/**
 * Tests for /api/admin/token-metadata — Metaplex on-chain metadata writes.
 *
 * REAL on-chain code (treasury signing for `create`, authority signing for
 * `update`). Tests pin the SAFE behavior: auth gating, key-presence
 * validation, env-vars-missing failure paths, action routing, mnemonic
 * derivation matching the expected authority address.
 *
 * Actual transaction submission (`sendRawTransaction` + `confirmTransaction`)
 * is mocked at the Solana Connection boundary — we don't fire real txs from
 * unit tests. Devnet smoke is the user's job before flipping the strangler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Solana connection mocks. Blockhash + tx signature must decode to the
// byte lengths @solana/web3.js expects (32 bytes and 64 bytes respectively)
// — `tx.serialize()` validates these internally and throws otherwise.
const FAKE_BLOCKHASH = "11111111111111111111111111111111"; // 32 bytes of zeros, valid base58
const FAKE_TX_SIG = "1111111111111111111111111111111111111111111111111111111111111111"; // 64 bytes, valid base58
const mockGetAccountInfo = vi.fn();
const mockGetLatestBlockhash = vi.fn(async () => ({
  blockhash: FAKE_BLOCKHASH,
  lastValidBlockHeight: 1234,
}));
const mockSendRawTransaction = vi.fn(async () => FAKE_TX_SIG);
const mockConfirmTransaction = vi.fn(async () => ({ value: { err: null } }));

vi.mock("@/lib/solana-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana-config")>(
    "@/lib/solana-config",
  );
  return {
    ...actual,
    getServerSolanaConnection: () => ({
      getAccountInfo: mockGetAccountInfo,
      getLatestBlockhash: mockGetLatestBlockhash,
      sendRawTransaction: mockSendRawTransaction,
      confirmTransaction: mockConfirmTransaction,
    }),
  };
});

beforeEach(() => {
  mockGetAccountInfo.mockReset();
  mockGetLatestBlockhash.mockClear();
  mockSendRawTransaction.mockClear();
  mockConfirmTransaction.mockClear();
  process.env.NEXT_PUBLIC_ADMIN_WALLET = "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";
  process.env.NEXT_PUBLIC_TREASURY_WALLET = "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56";
  process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";
  delete process.env.TREASURY_PRIVATE_KEY;
  delete process.env.METADATA_AUTHORITY_PRIVATE_KEY;
  delete process.env.METADATA_AUTHORITY_MNEMONIC;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ADMIN_WALLET;
  delete process.env.NEXT_PUBLIC_TREASURY_WALLET;
  delete process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT;
  delete process.env.TREASURY_PRIVATE_KEY;
  delete process.env.METADATA_AUTHORITY_PRIVATE_KEY;
  delete process.env.METADATA_AUTHORITY_MNEMONIC;
});

async function callPost(body: Record<string, unknown>) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/admin/token-metadata", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("auth gate", () => {
  it("403 when admin_wallet missing", async () => {
    const res = await callPost({ action: "check" });
    expect(res.status).toBe(403);
  });

  it("403 when admin_wallet doesn't match", async () => {
    const res = await callPost({ action: "check", admin_wallet: "GhostWaLLeT" });
    expect(res.status).toBe(403);
  });
});

describe("action=check (read-only)", () => {
  it("reports metadata_exists=true when PDA has data", async () => {
    mockGetAccountInfo.mockResolvedValueOnce({ data: Buffer.from("x".repeat(100)) });

    const res = await callPost({
      action: "check",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metadata_exists).toBe(true);
    expect(body.action_needed).toBe("update");
    expect(body.metadata_pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("reports metadata_exists=false when PDA is empty", async () => {
    mockGetAccountInfo.mockResolvedValueOnce(null);

    const res = await callPost({
      action: "check",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    const body = await res.json();
    expect(body.metadata_exists).toBe(false);
    expect(body.action_needed).toBe("create");
  });

  it("500 when getAccountInfo throws", async () => {
    mockGetAccountInfo.mockRejectedValueOnce(new Error("RPC down"));
    const res = await callPost({
      action: "check",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(500);
  });
});

describe("action=create (signing)", () => {
  it("503 when TREASURY_PRIVATE_KEY not set", async () => {
    const res = await callPost({
      action: "create",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/TREASURY_PRIVATE_KEY/);
  });

  it("500 when treasury keypair doesn't derive to TREASURY_WALLET_STR", async () => {
    // Generate a random key — it won't match the env's TREASURY_WALLET_STR.
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const randomKey = Keypair.generate();
    process.env.TREASURY_PRIVATE_KEY = bs58.encode(randomKey.secretKey);

    const res = await callPost({
      action: "create",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Treasury keypair mismatch/);
  });

  it("500 'Treasury keypair mismatch' when env key derives to wrong wallet — guards env-key drift", async () => {
    // Note: TREASURY_WALLET_STR is captured at solana-config module-load
    // time from NEXT_PUBLIC_TREASURY_WALLET, so we can't easily re-stub it
    // here. Instead we exercise the IMPORTANT defensive path: a treasury
    // PRIVATE key that doesn't derive to the configured public wallet
    // (i.e. someone rotated one env var without the other). MUST return
    // 500, not silently sign a transaction with a stale key.
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    process.env.TREASURY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);

    const res = await callPost({
      action: "create",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Treasury keypair mismatch/);
    // Critically: no transaction was attempted.
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("action=update", () => {
  it("503 when neither METADATA_AUTHORITY_PRIVATE_KEY nor MNEMONIC set", async () => {
    const res = await callPost({
      action: "update",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/METADATA_AUTHORITY/);
  });

  it("503 when authority is set but TREASURY_PRIVATE_KEY isn't (need fee payer)", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    process.env.METADATA_AUTHORITY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);

    const res = await callPost({
      action: "update",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/TREASURY_PRIVATE_KEY/);
  });

  it("404 when no metadata to update yet", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    process.env.METADATA_AUTHORITY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
    process.env.TREASURY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);

    mockGetAccountInfo.mockResolvedValueOnce(null);

    const res = await callPost({
      action: "update",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(404);
  });

  it("happy path with both keys + existing metadata submits + returns signature", async () => {
    // update path doesn't validate the treasury keypair-vs-public-wallet
    // match (unlike create), so this happy path works without env stubbing.
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    process.env.METADATA_AUTHORITY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
    process.env.TREASURY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);

    mockGetAccountInfo.mockResolvedValueOnce({ data: Buffer.from("x".repeat(100)) });

    const res = await callPost({
      action: "update",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("updated");
    expect(body.tx_signature).toBe(FAKE_TX_SIG);
    expect(mockSendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("action=verify (mnemonic derivation)", () => {
  it("503 when no authority configured", async () => {
    const res = await callPost({
      action: "verify",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(503);
  });

  it("returns matches=false when mnemonic derives a different wallet", async () => {
    // Random mnemonic — won't match the hardcoded EXPECTED_UPDATE_AUTHORITY
    process.env.METADATA_AUTHORITY_MNEMONIC =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    const res = await callPost({
      action: "verify",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toBe(false);
    expect(body.expected_authority).toBe("4Jm25GMWDFj4UFJTQjwo7mnDwddxSkXAthDGmkPjdMi4");
    expect(body.derived_address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

describe("unknown action", () => {
  it("400", async () => {
    const res = await callPost({
      action: "banana",
      admin_wallet: "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ",
    });
    expect(res.status).toBe(400);
  });
});
