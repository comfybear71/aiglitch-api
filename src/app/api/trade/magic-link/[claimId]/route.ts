/**
 * GET /api/trade/magic-link/[claimId] — public claim status (no auth).
 */

import { type NextRequest, NextResponse } from "next/server";

import { mintDecimals } from "@/lib/trade/build-transfer";
import { decodeClaimIdBase58 } from "@/lib/trade/magic-claim/claim-id";
import { claimUrl } from "@/lib/trade/magic-claim/config";
import { getMagicClaim } from "@/lib/trade/magic-claim/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ claimId: string }> };

export async function GET(_request: NextRequest, ctx: Ctx) {
  const { claimId } = await ctx.params;
  try {
    decodeClaimIdBase58(claimId);
  } catch {
    return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  }

  const row = await getMagicClaim(claimId);
  if (!row) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const decimals = mintDecimals(row.mint);
  const amountHuman = Number(row.amount_atomic) / 10 ** decimals;
  const expired = Date.now() > new Date(row.expires_at).getTime();

  return NextResponse.json({
    claimId: row.claim_id,
    claimUrl: claimUrl(row.claim_id),
    symbol: row.symbol,
    amountHuman,
    amountAtomic: row.amount_atomic,
    expiresAt: row.expires_at,
    status: expired && row.status === "pending" ? "expired" : row.status,
    senderTrunc: `${row.sender_wallet.slice(0, 4)}…${row.sender_wallet.slice(-4)}`,
    depositSig: row.deposit_sig,
    claimSig: row.claim_sig,
    refundSig: row.refund_sig,
  });
}
