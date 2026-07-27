/**
 * GET /api/trade/wallet/balances?wallet=
 * On-chain amounts for all trade-lane mints (core + Jupiter curated).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import { getTradeWalletTokenBalances } from "@/lib/trade/wallet-token-balances";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  try {
    const balances = await getTradeWalletTokenBalances(wallet);
    return NextResponse.json(
      { wallet, balances },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          Pragma: "no-cache",
        },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
