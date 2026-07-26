/**
 * POST /api/trade/magic-link/[claimId]/refund — sender cancel (unsigned refund tx).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import { buildMagicRefundTx } from "@/lib/trade/magic-claim/client";
import { decodeClaimIdBase58 } from "@/lib/trade/magic-claim/claim-id";
import { isMagicLinkEnabled } from "@/lib/trade/magic-claim/config";
import { getMagicClaim, updateMagicClaimStatus } from "@/lib/trade/magic-claim/db";
import { logMagicRefund } from "@/lib/trade/activity/log-magic";

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

  let body: { senderPublicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const senderPublicKey = body.senderPublicKey?.trim() ?? "";
  if (!senderPublicKey || !isValidSolanaAddress(senderPublicKey)) {
    return NextResponse.json({ error: "Invalid senderPublicKey" }, { status: 400 });
  }

  const row = await getMagicClaim(claimId);
  if (!row) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  if (row.sender_wallet !== senderPublicKey) {
    return NextResponse.json({ error: "Only the sender can refund" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: `Claim is ${row.status}` }, { status: 409 });
  }

  try {
    const built = await buildMagicRefundTx({
      sender: senderPublicKey,
      mint: row.mint,
      claimIdBytes: claimBytes,
    });
    return NextResponse.json({ transaction: built.transaction, claimId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { claimId } = await ctx.params;
  let body: { refundSignature?: string; senderPublicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const refundSignature = body.refundSignature?.trim();
  const senderPublicKey = body.senderPublicKey?.trim() ?? "";
  if (!refundSignature) return NextResponse.json({ error: "refundSignature required" }, { status: 400 });

  const row = await getMagicClaim(claimId);
  if (!row) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  if (senderPublicKey && row.sender_wallet !== senderPublicKey) {
    return NextResponse.json({ error: "Sender mismatch" }, { status: 403 });
  }

  await updateMagicClaimStatus(claimId, { status: "refunded", refundSig: refundSignature });

  if (row) await logMagicRefund(row, refundSignature);

  return NextResponse.json({ ok: true, status: "refunded" });
}
