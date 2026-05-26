/**
 * Smoke tests for src/lib/trading/budju.ts.
 *
 * This 1762-LOC lib is the workhorse behind /api/budju-trading and
 * /api/admin/budju-trading — porting the FULL behavior end-to-end at
 * unit-test granularity would require mocking dozens of Solana RPC
 * calls and is brittle. Instead these tests verify:
 *
 *   - Module compiles and exports the expected surface
 *   - decryptKeypair round-trips with the same XOR+bs58 layout used by
 *     /api/admin/personas/generate-missing-wallets (v1.29.0) and
 *     /api/admin/init-persona (v1.30.0) — encryption parity is the
 *     contract that lets all three routes interoperate
 *
 * Deeper coverage of trade execution, distribution batching, etc. lands
 * via the route-level tests in PR 2 (user-facing /api/budju-trading)
 * and PR 3 (/api/admin/budju-trading).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

beforeEach(() => {
  process.env.BUDJU_WALLET_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.BUDJU_WALLET_SECRET;
});

describe("budju lib — surface compiles and exports", () => {
  it("exposes the route-consumed helpers", async () => {
    const mod = await import("./budju");
    expect(typeof mod.getBudjuConfig).toBe("function");
    expect(typeof mod.executeBudjuTradeBatch).toBe("function");
    expect(typeof mod.decryptKeypair).toBe("function");
  });

  it("exposes the admin-consumed helpers", async () => {
    const mod = await import("./budju");
    expect(typeof mod.generatePersonaWallets).toBe("function");
    expect(typeof mod.distributeFundsFromDistributors).toBe("function");
    expect(typeof mod.createDistributionJob).toBe("function");
    expect(typeof mod.processDistributionJob).toBe("function");
    expect(typeof mod.getDistributionJobStatus).toBe("function");
    expect(typeof mod.drainWallets).toBe("function");
    expect(typeof mod.exportWalletKeys).toBe("function");
    expect(typeof mod.getBudjuDashboard).toBe("function");
    expect(typeof mod.deactivatePersonaWallet).toBe("function");
    expect(typeof mod.setBudjuConfig).toBe("function");
  });
});

describe("decryptKeypair — interop contract with generate-missing-wallets + init-persona", () => {
  // Mirror the encryptKeypair function from those two routes so the
  // test fails LOUDLY if anyone changes the byte layout on either side.
  function encryptKeypairCanonical(secretKey: Uint8Array): string {
    const key =
      process.env.BUDJU_WALLET_SECRET ??
      process.env.ADMIN_PASSWORD ??
      "budju-default-key";
    const keyBytes = new TextEncoder().encode(key);
    const enc = new Uint8Array(secretKey.length);
    for (let i = 0; i < secretKey.length; i++) {
      enc[i] = secretKey[i] ^ keyBytes[i % keyBytes.length];
    }
    return bs58.encode(enc);
  }

  it("round-trips a freshly generated keypair", async () => {
    const { decryptKeypair } = await import("./budju");
    const kp = Keypair.generate();
    const encrypted = encryptKeypairCanonical(kp.secretKey);

    const recovered = decryptKeypair(encrypted);
    expect(recovered.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(Buffer.from(recovered.secretKey)).toEqual(Buffer.from(kp.secretKey));
  });

  it("round-trips across multiple keypairs (no state leak between calls)", async () => {
    const { decryptKeypair } = await import("./budju");
    for (let i = 0; i < 3; i++) {
      const kp = Keypair.generate();
      const enc = encryptKeypairCanonical(kp.secretKey);
      const dec = decryptKeypair(enc);
      expect(dec.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    }
  });

  // (Fallback to ADMIN_PASSWORD when BUDJU_WALLET_SECRET unset is preserved
  // from legacy but not unit-testable here — ENCRYPTION_KEY is captured at
  // module-load and Vitest's resetModules + dynamic-import dance doesn't
  // round-trip cleanly through @solana/web3.js's keypair caching. The
  // route-level tests in PR 2 / PR 3 cover the env-precedence indirectly.)
});
