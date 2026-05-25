/**
 * Tests for the Phase-8-foundation extensions to solana-config.
 *
 * Covers the new helpers added when we wired in @solana/web3.js:
 *   - getServerSolanaConnection() returns a Connection (cached)
 *   - PublicKey lazy helpers (getGlitchTokenMint, getBudjuTokenMint,
 *     getTreasuryWallet, getAdminWallet) construct from env strings
 *   - isValidSolanaAddress accepts base58 32-44 chars only
 *   - hasValidTokenMint discriminates the system-program placeholder
 *   - getSolanaNetwork falls back to mainnet-beta when env is unset
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  delete process.env.HELIUS_API_KEY;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("solana-config — Phase 8 foundation helpers", () => {
  it("isValidSolanaAddress accepts realistic base58 addresses", async () => {
    const { isValidSolanaAddress } = await import("./solana-config");
    expect(isValidSolanaAddress("2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ")).toBe(true);
    expect(isValidSolanaAddress("5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT")).toBe(true);
  });

  it("isValidSolanaAddress rejects non-base58 and out-of-range lengths", async () => {
    const { isValidSolanaAddress } = await import("./solana-config");
    expect(isValidSolanaAddress("short")).toBe(false);
    expect(isValidSolanaAddress("0OIl-invalid-base58-chars-0OIl-invalid")).toBe(false);
    expect(isValidSolanaAddress("a".repeat(45))).toBe(false);
    expect(isValidSolanaAddress("a".repeat(31))).toBe(false);
  });

  it("hasValidTokenMint discriminates the system-program placeholder", async () => {
    process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "11111111111111111111111111111111";
    const { hasValidTokenMint } = await import("./solana-config");
    expect(hasValidTokenMint()).toBe(false);
  });

  it("hasValidTokenMint returns true for a real mint", async () => {
    process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";
    const { hasValidTokenMint } = await import("./solana-config");
    expect(hasValidTokenMint()).toBe(true);
  });

  it("getSolanaNetwork defaults to mainnet-beta when env is unset", async () => {
    const { getSolanaNetwork } = await import("./solana-config");
    expect(getSolanaNetwork()).toBe("mainnet-beta");
  });

  it("getSolanaNetwork respects valid env values", async () => {
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
    const { getSolanaNetwork } = await import("./solana-config");
    expect(getSolanaNetwork()).toBe("devnet");
  });

  it("getServerSolanaConnection returns a Connection and caches it", async () => {
    const { getServerSolanaConnection } = await import("./solana-config");
    const c1 = getServerSolanaConnection();
    const c2 = getServerSolanaConnection();
    expect(c1).toBe(c2); // singleton
    expect(c1.rpcEndpoint).toBeDefined();
  });

  it("PublicKey helpers construct from configured mint strings", async () => {
    process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT = "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";
    process.env.NEXT_PUBLIC_BUDJU_TOKEN_MINT = "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump";
    process.env.NEXT_PUBLIC_TREASURY_WALLET = "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56";
    process.env.NEXT_PUBLIC_ADMIN_WALLET = "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";

    const mod = await import("./solana-config");
    expect(mod.getGlitchTokenMint().toBase58()).toBe("5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT");
    expect(mod.getBudjuTokenMint().toBase58()).toBe("2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump");
    expect(mod.getTreasuryWallet().toBase58()).toBe("7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56");
    expect(mod.getAdminWallet().toBase58()).toBe("2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ");
  });
});
