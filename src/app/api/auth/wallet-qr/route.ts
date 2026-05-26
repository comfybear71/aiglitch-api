/**
 * Public Wallet QR Auth — Ed25519 challenge/sign/verify for any user
 * (NOT admin-only). Same shape as /api/wallet/verify but with a
 * QR-code-driven cross-device flow: desktop generates the challenge,
 * phone signs it via Phantom, desktop polls for approval.
 *
 * Audit (per locked decision #6, simulation-route shape):
 *   - No server-held private keys.
 *   - No on-chain writes.
 *   - Pure: random nonce + cache challenge + Node-native Ed25519 verify.
 *   - Cache is in-memory only (L1) — no Redis dep, ephemeral by design.
 *
 * Endpoints:
 *   GET                  → generate new challenge { challengeId, message }
 *   GET ?c=<id>          → poll challenge status { status, wallet? }
 *   POST { challengeId, signature, publicKey } → verify + approve
 *   POST { action: "approve_original", originalChallengeId, wallet }
 *                         → cross-device approval bridge
 */

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { cache } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHALLENGE_TTL = 600; // 10 minutes
const CACHE_PREFIX = "public-wallet-auth:";

export async function GET(request: NextRequest) {
  const challengeId = request.nextUrl.searchParams.get("c");

  if (challengeId) {
    const challenge = cache.get<{
      message: string;
      status: "pending" | "approved";
      wallet?: string;
    }>(`${CACHE_PREFIX}${challengeId}`);

    if (!challenge) {
      return NextResponse.json({ status: "expired" });
    }

    if (challenge.status === "approved" && challenge.wallet) {
      return NextResponse.json({ status: "approved", wallet: challenge.wallet });
    }

    return NextResponse.json({ status: "pending", message: challenge.message });
  }

  const id = randomBytes(16).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const message = `Welcome to AIG!itch\n\nSign this message to connect your wallet.\n\nChallenge: ${nonce}\nTimestamp: ${new Date().toISOString()}`;

  cache.set(`${CACHE_PREFIX}${id}`, CHALLENGE_TTL, {
    message,
    nonce,
    status: "pending",
    created: Date.now(),
  });

  return NextResponse.json({ challengeId: id, message });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { challengeId, signature, publicKey, action, originalChallengeId, wallet } = body;

    // Cross-device approval: after phone verifies a fresh challenge, it
    // posts back here to mark the desktop's original challenge approved.
    if (action === "approve_original" && originalChallengeId && wallet) {
      const original = cache.get<Record<string, unknown>>(`${CACHE_PREFIX}${originalChallengeId}`);
      if (original) {
        cache.set(`${CACHE_PREFIX}${originalChallengeId}`, CHALLENGE_TTL, {
          ...original,
          status: "approved",
          wallet,
        });
      }
      return NextResponse.json({ success: true });
    }

    if (!challengeId || !signature || !publicKey) {
      return NextResponse.json(
        { error: "Missing challengeId, signature, or publicKey" },
        { status: 400 },
      );
    }

    const challenge = cache.get<{
      message: string;
      nonce: string;
      status: string;
    }>(`${CACHE_PREFIX}${challengeId}`);

    if (!challenge) {
      return NextResponse.json({ error: "Challenge expired" }, { status: 404 });
    }

    if (challenge.status !== "pending") {
      return NextResponse.json({ error: "Challenge already used" }, { status: 400 });
    }

    // Ed25519 verify via Node's built-in crypto (no nacl/tweetnacl dep needed).
    // The Solana public key is a raw Ed25519 key — DER-wrap it for createPublicKey.
    const { PublicKey } = await import("@solana/web3.js");
    const cryptoMod = await import("crypto");

    const pubKeyBytes = new PublicKey(publicKey).toBytes();
    const messageBytes = new TextEncoder().encode(challenge.message);
    const sigBytes = Buffer.from(signature, "base64");

    const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const derKey = Buffer.concat([derPrefix, pubKeyBytes]);
    const keyObj = cryptoMod.createPublicKey({ key: derKey, format: "der", type: "spki" });

    const isValid = cryptoMod.verify(null, messageBytes, keyObj, sigBytes);

    if (!isValid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    cache.set(`${CACHE_PREFIX}${challengeId}`, CHALLENGE_TTL, {
      ...challenge,
      status: "approved",
      wallet: publicKey,
    });

    return NextResponse.json({ success: true, wallet: publicKey });
  } catch (err) {
    console.error("[wallet-qr] Verification error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
