/**
 * POST /api/trade/magic-link/[claimId]/claim — build unsigned claim tx.
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import { buildMagicClaimTx } from "@/lib/trade/magic-claim/client";
import { decodeClaimIdBase58 } from "@/lib/trade/magic-claim/claim-id";
import { isMagicLinkEnabled } from "@/lib/trade/magic-claim/config";
import { getMagicClaim, updateMagicClaimStatus } from "@/lib/trade/magic-claim/db";
import { logMagicClaim } from "@/lib/trade/activity/log-magic";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ claimId: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  if (!isMagicLinkEnabled()) {
    return NextResponse.json({ error: "Magic link not enabled" }, { status: 503 });
  }

  const { claimId } = await ctx.params;
  let claimBytes: Buffer;
  try {
    claimBytes = decodeClaimIdBase58(claimId);
  } catch {
    return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  }

  let body: { recipientPublicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const recipientPublicKey = body.recipientPublicKey?.trim() ?? "";
  if (!recipientPublicKey || !isValidSolanaAddress(recipientPublicKey)) {
    return NextResponse.json({ error: "Invalid recipientPublicKey" }, { status: 400 });
  }

  const row = await getMagicClaim(claimId);
  if (!row) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ error: `Claim is ${row.status}` }, { status: 409 });
  }
  if (Date.now() > new Date(row.expires_at).getTime()) {
    return NextResponse.json({ error: "Claim expired" }, { status: 410 });
  }

  try {
    const built = await buildMagicClaimTx({
      recipient: recipientPublicKey,
      mint: row.mint,
      claimIdBytes: claimBytes,
    });
    return NextResponse.json({ transaction: built.transaction, claimId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/** Optional: client calls after submit with claimSignature */
export async function PUT(request: NextRequest, ctx: Ctx) {
  const { claimId } = await ctx.params;
  let body: { claimSignature?: string; recipientPublicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const claimSignature = body.claimSignature?.trim();
  if (!claimSignature) return NextResponse.json({ error: "claimSignature required" }, { status: 400 });

  const row = await getMagicClaim(claimId);
  if (!row) return NextResponse.json({ error: "Claim not found" }, { status: 404 });

  await updateMagicClaimStatus(claimId, { status: "claimed", claimSig: claimSignature });

  const recipient = body.recipientPublicKey?.trim();
  if (recipient) await logMagicClaim(row, recipient, claimSignature);

  return NextResponse.json({ ok: true, status: "claimed" });
}
