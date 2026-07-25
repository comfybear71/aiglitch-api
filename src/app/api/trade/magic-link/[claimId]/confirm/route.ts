/**
 * POST /api/trade/magic-link/[claimId]/confirm — mark deposit landed on-chain.
 */

import { type NextRequest, NextResponse } from "next/server";

import { decodeClaimIdBase58 } from "@/lib/trade/magic-claim/claim-id";
import { getMagicClaim, updateMagicClaimStatus } from "@/lib/trade/magic-claim/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ claimId: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  const { claimId } = await ctx.params;
  try {
    decodeClaimIdBase58(claimId);
  } catch {
    return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  }

  let body: { depositSignature?: string; senderPublicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const depositSignature = body.depositSignature?.trim() ?? "";
  const senderPublicKey = body.senderPublicKey?.trim() ?? "";
  if (!depositSignature || depositSignature.length < 80) {
    return NextResponse.json({ error: "Invalid depositSignature" }, { status: 400 });
  }

  const row = await getMagicClaim(claimId);
  if (!row) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  if (senderPublicKey && senderPublicKey !== row.sender_wallet) {
    return NextResponse.json({ error: "Sender mismatch" }, { status: 403 });
  }

  await updateMagicClaimStatus(claimId, {
    status: "pending",
    depositSig: depositSignature,
  });

  return NextResponse.json({ ok: true, status: "pending", claimId });
}
