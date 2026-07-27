/**
 * GET /api/trade/markets/curated — Jupiter majors + OTC checkout hints for Markets UI.
 */

import { NextResponse } from "next/server";

import {
  OTC_CHECKOUT_PAYMENT_ASSETS,
  OTC_TREASURY_LISTING_GOAL_SOL,
  TRADE_CURATED_JUPITER_TOKENS,
} from "@/lib/trade/curated-markets";
import { resolveTradeTokenMetaForSymbols } from "@/lib/trade/token-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const symbols = TRADE_CURATED_JUPITER_TOKENS.map((t) => t.symbol);
  const metaBySymbol = await resolveTradeTokenMetaForSymbols(symbols);

  return NextResponse.json({
    tokens: TRADE_CURATED_JUPITER_TOKENS.map((t) => {
      const meta = metaBySymbol[t.symbol];
      return {
        symbol: t.symbol,
        mint: t.mint,
        decimals: t.decimals,
        defaultQuote: t.defaultQuote,
        yieldLst: t.yieldLst ?? false,
        name: meta?.name ?? t.symbol,
        iconUrl: meta?.iconUrl ?? null,
        iconEmoji: meta?.iconEmoji ?? t.symbol.slice(0, 1),
      };
    }),
    otc: {
      paymentAssets: [...OTC_CHECKOUT_PAYMENT_ASSETS],
      treasuryListingGoalSol: OTC_TREASURY_LISTING_GOAL_SOL,
      note: "GLITCH (OTC) checkout is SOL-only; USDC/BUDJU pair cards are reference prices until treasury milestone.",
    },
  });
}
