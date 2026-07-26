/**
 * POST /api/trade/magic-link/[claimId]/abandon — discard unfunded link (no on-chain tx).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
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
    return NextResponse.json({ error: "Only the sender can abandon" }, { status: 403 });
  }
  if (row.status !== "awaiting_deposit") {
    return NextResponse.json({ error: `Claim is ${row.status}` }, { status: 409 });
  }

  await updateMagicClaimStatus(claimId, { status: "abandoned" });
  return NextResponse.json({ ok: true, status: "abandoned", claimId });
}
