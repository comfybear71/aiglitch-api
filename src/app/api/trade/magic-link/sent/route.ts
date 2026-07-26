/**
 * GET /api/trade/magic-link/sent?wallet= — sender's magic links (manage / cancel / refund).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import { mintDecimals } from "@/lib/trade/build-transfer";
import { claimUrl } from "@/lib/trade/magic-claim/config";
import { listMagicClaimsBySender } from "@/lib/trade/magic-claim/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function amountHuman(symbol: string, amountAtomic: string): number {
  const dec = mintDecimals(symbol);
  return Number(amountAtomic) / 10 ** dec;
}

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }

  const rows = await listMagicClaimsBySender(wallet, 40);
  const now = Date.now();

  return NextResponse.json({
    claims: rows.map((r) => {
      const expired = now > new Date(r.expires_at).getTime();
      return {
        claimId: r.claim_id,
        claimUrl: claimUrl(r.claim_id),
        symbol: r.symbol,
        amountHuman: amountHuman(r.symbol, r.amount_atomic),
        status: r.status,
        expiresAt: r.expires_at.toISOString(),
        expired,
        canAbandon: r.status === "awaiting_deposit",
        canRefund: r.status === "pending" && !expired,
        depositSig: r.deposit_sig,
        refundSig: r.refund_sig,
      };
    }),
  });
}
