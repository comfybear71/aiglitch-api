/**
 * Tests for /api/admin/wallet-auth.
 *
 * Most actions can be covered without real crypto by mocking the cache,
 * but the POST happy path needs an honest Ed25519 signature to prove the
 * verifySignature() helper actually works. We generate a real keypair
 * via @solana/web3.js inside the test, use tweetnacl (already a
 * transitive dep) to sign the challenge message, and feed that signature
 * to POST — same path Phantom would take.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Sign a message with a Solana Keypair using Node's native Ed25519.
// `Keypair.secretKey` is [seed(32) || pubkey(32)] — we DER-wrap the
// first 32 bytes per RFC 8410 to feed `crypto.createPrivateKey`.
// Same shape as the route's verify path (DER-wrapped public key),
// just on the signing side.
function signWithKeypair(kp: Keypair, message: string): Uint8Array {
  const seed = kp.secretKey.slice(0, 32);
  const derPrefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const derKey = Buffer.concat([derPrefix, Buffer.from(seed)]);
  const keyObj = createPrivateKey({ key: derKey, format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(message, "utf-8"), keyObj);
}

beforeEach(() => {
  vi.resetModules();
  // The cache is module-singleton — we don't mock it, we let the route
  // share the same L1 cache for the whole test (mirrors how it works
  // in a single Vercel instance).
});

afterEach(() => {
  delete process.env.ADMIN_WALLET_PUBKEY;
  delete process.env.ADMIN_WALLET;
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/admin/wallet-auth${query}`, init);
}

describe("GET /api/admin/wallet-auth — challenge minting", () => {
  it("mints a new challenge with id + message", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.message).toMatch(/AIG!itch Trading Access/);
    expect(body.message).toMatch(/Challenge:/);
  });

  it("returns a distinct id + nonce each call", async () => {
    const { GET } = await import("./route");
    const r1 = await (await GET(await buildRequest())).json();
    const r2 = await (await GET(await buildRequest())).json();
    expect(r1.challengeId).not.toBe(r2.challengeId);
    expect(r1.message).not.toBe(r2.message);
  });
});

describe("GET /api/admin/wallet-auth?c=... — poll challenge", () => {
  it("returns status=expired for an unknown challenge id", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?c=does-not-exist"));
    const body = await res.json();
    expect(body.status).toBe("expired");
  });

  it("returns status=pending right after minting", async () => {
    const { GET } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();
    const polled = await (await GET(await buildRequest(`?c=${minted.challengeId}`))).json();
    expect(polled.status).toBe("pending");
  });
});

describe("GET /api/admin/wallet-auth?session=... — validate session", () => {
  it("401 for an unknown session token", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?session=nope"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });
});

describe("POST /api/admin/wallet-auth — signature verification", () => {
  it("400 when required fields missing", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when challenge expired / unknown", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: "ghost",
          signature: "sig",
          publicKey: "pk",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("500 when ADMIN_WALLET env not configured", async () => {
    // No ADMIN_WALLET env set at this point
    delete process.env.ADMIN_WALLET_PUBKEY;
    delete process.env.ADMIN_WALLET;
    delete process.env.NEXT_PUBLIC_ADMIN_WALLET;

    const { GET, POST } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: minted.challengeId,
          signature: "x".repeat(88),
          publicKey: "anything",
        }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("403 when publicKey doesn't match the admin wallet", async () => {
    process.env.ADMIN_WALLET = "AdminWalletAddressGoesHere11111111111111111";
    const { GET, POST } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();

    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: minted.challengeId,
          signature: "x".repeat(88),
          publicKey: "SomeOtherWallet22222222222222222222222222",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Unauthorized wallet/);
  });

  it("403 when signature is invalid for the right wallet", async () => {
    const kp = Keypair.generate();
    process.env.ADMIN_WALLET = kp.publicKey.toBase58();

    const { GET, POST } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();

    // Garbage signature
    const fakeSig = bs58.encode(new Uint8Array(64).fill(7));

    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: minted.challengeId,
          signature: fakeSig,
          publicKey: kp.publicKey.toBase58(),
        }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid signature/);
  });

  it("happy path — real Ed25519 sig issues session token, sets challenge=approved", async () => {
    const kp = Keypair.generate();
    process.env.ADMIN_WALLET = kp.publicKey.toBase58();

    const { GET, POST } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();

    // Sign the challenge message the same way Phantom would.
    const signature = signWithKeypair(kp, minted.message);
    const signatureBase58 = bs58.encode(signature);

    const postRes = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: minted.challengeId,
          signature: signatureBase58,
          publicKey: kp.publicKey.toBase58(),
        }),
      }),
    );
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.ok).toBe(true);
    expect(postBody.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(postBody.expiresIn).toBe(86_400);

    // Subsequent poll surfaces the approval + session token.
    const pollRes = await GET(await buildRequest(`?c=${minted.challengeId}`));
    const pollBody = await pollRes.json();
    expect(pollBody.status).toBe("approved");
    expect(pollBody.sessionToken).toBe(postBody.sessionToken);
    expect(pollBody.wallet).toBe(kp.publicKey.toBase58());

    // Session validation returns valid=true with the wallet.
    const validateRes = await GET(await buildRequest(`?session=${postBody.sessionToken}`));
    const validateBody = await validateRes.json();
    expect(validateBody.valid).toBe(true);
    expect(validateBody.wallet).toBe(kp.publicKey.toBase58());
  });

  it("400 when the challenge has already been used", async () => {
    const kp = Keypair.generate();
    process.env.ADMIN_WALLET = kp.publicKey.toBase58();

    const { GET, POST } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();
    const signature = signWithKeypair(kp, minted.message);

    const body = JSON.stringify({
      challengeId: minted.challengeId,
      signature: bs58.encode(signature),
      publicKey: kp.publicKey.toBase58(),
    });

    // First use succeeds.
    await POST(await buildRequest("", { method: "POST", body }));
    // Second use rejected as already-used.
    const second = await POST(await buildRequest("", { method: "POST", body }));
    expect(second.status).toBe(400);
    const errBody = await second.json();
    expect(errBody.error).toMatch(/already used/);
  });
});

describe("PUT /api/admin/wallet-auth — get_message", () => {
  it("400 when challengeId missing", async () => {
    const { PUT } = await import("./route");
    const res = await PUT(
      await buildRequest("", { method: "PUT", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when challenge unknown / not pending", async () => {
    const { PUT } = await import("./route");
    const res = await PUT(
      await buildRequest("", {
        method: "PUT",
        body: JSON.stringify({ challengeId: "nope" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns the message for a pending challenge", async () => {
    const { GET, PUT } = await import("./route");
    const minted = await (await GET(await buildRequest())).json();
    const res = await PUT(
      await buildRequest("", {
        method: "PUT",
        body: JSON.stringify({ challengeId: minted.challengeId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(minted.message);
  });
});
