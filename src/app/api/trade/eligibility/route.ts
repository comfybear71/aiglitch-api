/**
 * GET /api/trade/eligibility?wallet=
 *
 * Public read-only gate for trade.aiglitch.app: enough on-chain $BUDJU
 * unlocks Swap + Portfolio. Does not touch treasury keys or sign txs.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getTradeEligibility } from "@/lib/trade/eligibility";
import { isValidSolanaAddress } from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  const result = await getTradeEligibility(wallet);
  return NextResponse.json(result);
}
