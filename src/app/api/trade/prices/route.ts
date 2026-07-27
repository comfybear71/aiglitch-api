/**
 * GET /api/trade/prices — USD prices for trade-lane tokens.
 * Query: symbols=SOL,BUDJU,USDC,JUP (default: all allowed)
 */

import { type NextRequest, NextResponse } from "next/server";

import { GLITCH_TOKEN_MINT_STR } from "@/lib/solana-config";
import {
  TRADE_ALLOWED_MINTS,
  TRADE_SYMBOL_TO_MINT,
} from "@/lib/trade/curated-markets";
import { getOtcGlitchPriceUsd } from "@/lib/otc-bonding-curve";
import { resolveTradeSymbolPrices } from "@/lib/trade/token-usd-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("symbols")?.trim();
  const symbols = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(TRADE_SYMBOL_TO_MINT);

  const mints: string[] = [];
  for (const sym of symbols) {
    const mint =
      TRADE_SYMBOL_TO_MINT[sym.toUpperCase()] ?? TRADE_SYMBOL_TO_MINT[sym];
    if (mint && TRADE_ALLOWED_MINTS.has(mint)) mints.push(mint);
  }

  if (mints.length === 0) {
    return NextResponse.json({ error: "No valid symbols" }, { status: 400 });
  }

  try {
    const wantsGlitch = mints.includes(GLITCH_TOKEN_MINT_STR);
    const jupiterMints = wantsGlitch
      ? mints.filter((m) => m !== GLITCH_TOKEN_MINT_STR)
      : mints;

    const prices = jupiterMints.length > 0 ? await resolveTradeSymbolPrices(jupiterMints) : {};

    if (wantsGlitch) {
      const otcUsd = await getOtcGlitchPriceUsd();
      if (otcUsd != null && Number.isFinite(otcUsd)) {
        prices.GLITCH = otcUsd;
      }
    }

    return NextResponse.json({ prices, asOf: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
