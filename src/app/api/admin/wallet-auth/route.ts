/**
 * Admin API — Phantom-wallet challenge/response auth.
 *
 * Port of legacy aiglitch/src/app/api/admin/wallet-auth/route.ts.
 * Alternate admin login path for mobile/iPad sessions where typing the
 * `ADMIN_PASSWORD` cookie flow is painful. Uses a 3-step QR flow:
 *
 *   1. iPad calls `GET /api/admin/wallet-auth` (no params)
 *      → server generates a challenge + nonce, returns `{ challengeId, message }`
 *      → iPad renders the challengeId as a QR code on screen.
 *   2. iPhone (with Phantom installed) scans the QR + signs `message`
 *      with the admin wallet's keypair → POSTs `{ challengeId, signature,
 *      publicKey }` here.
 *      → server verifies the Ed25519 signature against the configured
 *        admin wallet public key + issues a session token, marks challenge
 *        as `approved`.
 *   3. iPad polls `GET /api/admin/wallet-auth?c={challengeId}` periodically
 *      → once the challenge flips to `approved`, the response includes
 *        the session token; iPad stores it + uses for subsequent admin calls.
 *
 * Plus `?session={token}` mode that validates an existing session token
 * (returns `{ valid, wallet }` or 401).
 *
 * **Cross-instance storage.** Challenge + session records use
 * `cache.setShared` / `cache.getShared` so the QR flow works when
 * iPad, phone, and poll hit different Vercel instances (requires
 * Upstash Redis env vars on the API project).
 *
 * **Ed25519 verification.** Uses Node's `crypto.verify` with a DER-wrapped
 * raw public key (RFC 8410). Same byte-exact pattern as legacy so existing
 * Phantom signatures continue to validate post-flip.
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomBytes, createHmac, createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { cache } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHALLENGE_TTL = 300;      // 5 min — admin has to scan + sign within this window
const SESSION_TTL = 86_400;     // 24 hours
const CACHE_PREFIX = "wallet-auth:";
const SESSION_PREFIX = "wallet-session:";

interface ChallengeRecord {
  message: string;
  nonce: string;
  status: "pending" | "approved" | "rejected";
  created: number;
  sessionToken?: string;
  wallet?: string;
}

interface SessionRecord {
  wallet: string;
  created: number;
}

function getAdminWalletPubkey(): string | null {
  return (
    process.env.ADMIN_WALLET_PUBKEY ??
    process.env.ADMIN_WALLET ??
    process.env.NEXT_PUBLIC_ADMIN_WALLET ??
    null
  );
}

/**
 * GET — three modes selected by query param:
 *   `?session=...`        → validate an existing session token
 *   `?c={challengeId}`    → poll status of a pending challenge
 *   (no params)           → mint a new challenge for the QR flow
 */
export async function GET(request: NextRequest) {
  const challengeId = request.nextUrl.searchParams.get("c");
  const sessionToken = request.nextUrl.searchParams.get("session");

  // Mode 3: validate session token.
  if (sessionToken) {
    const session = await cache.getShared<SessionRecord>(
      `${SESSION_PREFIX}${sessionToken}`,
      SESSION_TTL,
    );
    if (session) {
      return NextResponse.json({ valid: true, wallet: session.wallet });
    }
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  // Mode 2: poll challenge status.
  if (challengeId) {
    const challenge = await cache.getShared<ChallengeRecord>(
      `${CACHE_PREFIX}${challengeId}`,
      CHALLENGE_TTL,
    );

    if (!challenge) {
      return NextResponse.json({ status: "expired" });
    }
    if (challenge.status === "approved" && challenge.sessionToken) {
      return NextResponse.json({
        status: "approved",
        sessionToken: challenge.sessionToken,
        wallet: challenge.wallet,
      });
    }
    return NextResponse.json({ status: challenge.status });
  }

  // Mode 1: mint a new challenge.
  const id = randomBytes(16).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const message = `AIG!itch Trading Access\n\nSign this message to authorize trading controls.\n\nChallenge: ${nonce}\nTimestamp: ${new Date().toISOString()}`;

  cache.setShared<ChallengeRecord>(`${CACHE_PREFIX}${id}`, CHALLENGE_TTL, {
    message,
    nonce,
    status: "pending",
    created: Date.now(),
  });

  return NextResponse.json({ challengeId: id, message });
}

/**
 * POST — verify a signed challenge from Phantom.
 * Body: { challengeId, signature, publicKey }
 *   - publicKey must match the configured admin wallet
 *   - signature must be a valid Ed25519 sig over the challenge's message
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      challengeId?: string;
      signature?: string;
      publicKey?: string;
    };
    const { challengeId, signature, publicKey } = body;

    if (!challengeId || !signature || !publicKey) {
      return NextResponse.json(
        { error: "Missing challengeId, signature, or publicKey" },
        { status: 400 },
      );
    }

    const challenge = await cache.getShared<ChallengeRecord>(
      `${CACHE_PREFIX}${challengeId}`,
      CHALLENGE_TTL,
    );
    if (!challenge) {
      return NextResponse.json(
        { error: "Challenge expired or not found" },
        { status: 404 },
      );
    }
    if (challenge.status !== "pending") {
      return NextResponse.json({ error: "Challenge already used" }, { status: 400 });
    }

    const adminWallet = getAdminWalletPubkey();
    if (!adminWallet) {
      return NextResponse.json(
        { error: "ADMIN_WALLET_PUBKEY not configured" },
        { status: 500 },
      );
    }

    if (publicKey !== adminWallet) {
      // Mark rejected so the iPad's poll surfaces the failure quickly.
      cache.setShared<ChallengeRecord>(`${CACHE_PREFIX}${challengeId}`, CHALLENGE_TTL, {
        ...challenge,
        status: "rejected",
      });
      return NextResponse.json(
        { error: "Unauthorized wallet — not the admin wallet" },
        { status: 403 },
      );
    }

    if (!verifySignature(challenge.message, signature, publicKey)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    // Issue session token. HMAC over (pubkey + nonce + timestamp) keyed on a
    // per-token random secret — output is opaque to the client, only usable
    // via lookup on `wallet-session:<token>`.
    const sessionToken = createHmac("sha256", randomBytes(32))
      .update(`${publicKey}:${Date.now()}:${challenge.nonce}`)
      .digest("hex");

    cache.setShared<SessionRecord>(`${SESSION_PREFIX}${sessionToken}`, SESSION_TTL, {
      wallet: publicKey,
      created: Date.now(),
    });

    cache.setShared<ChallengeRecord>(`${CACHE_PREFIX}${challengeId}`, CHALLENGE_TTL, {
      ...challenge,
      status: "approved",
      sessionToken,
      wallet: publicKey,
    });

    return NextResponse.json({ ok: true, sessionToken, expiresIn: SESSION_TTL });
  } catch (err) {
    console.error("[wallet-auth] POST error:", err);
    return NextResponse.json(
      { error: `Auth failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

/**
 * PUT — return the message that needs signing for a given challenge.
 * Used by the sign page on the iPhone before forwarding to Phantom.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { challengeId?: string };
    const { challengeId } = body;
    if (!challengeId) {
      return NextResponse.json({ error: "Missing challengeId" }, { status: 400 });
    }

    const challenge = await cache.getShared<ChallengeRecord>(
      `${CACHE_PREFIX}${challengeId}`,
      CHALLENGE_TTL,
    );
    if (!challenge || challenge.status !== "pending") {
      return NextResponse.json(
        { error: "Challenge expired or already used" },
        { status: 404 },
      );
    }
    return NextResponse.json({ message: challenge.message });
  } catch (err) {
    console.error("[wallet-auth] PUT error:", err);
    return NextResponse.json({ error: "Failed to get challenge" }, { status: 500 });
  }
}

/**
 * Verify a Phantom-produced Ed25519 signature.
 *
 * Phantom signs the raw message bytes (UTF-8) with the wallet's Ed25519
 * private key. To verify with Node's crypto module we have to DER-wrap
 * the 32-byte raw public key per RFC 8410, then call `crypto.verify`
 * with a null algorithm (Ed25519 doesn't take a hash parameter).
 *
 * Returns false on any failure (bad base58, malformed key, bad signature)
 * — never throws, so the caller can return a clean 403.
 */
function verifySignature(
  message: string,
  signatureBase58: string,
  publicKeyBase58: string,
): boolean {
  try {
    const pubkey = new PublicKey(publicKeyBase58);
    const signatureBytes = bs58.decode(signatureBase58);
    const messageBytes = Buffer.from(message, "utf-8");

    // DER prefix for Ed25519 SPKI public key (RFC 8410).
    const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const derKey = Buffer.concat([derPrefix, Buffer.from(pubkey.toBytes())]);

    const keyObj = createPublicKey({ key: derKey, format: "der", type: "spki" });
    return verify(null, messageBytes, keyObj, signatureBytes);
  } catch (err) {
    console.error("[wallet-auth] Signature verification error:", err);
    return false;
  }
}
