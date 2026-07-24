/**
 * GET /api/trade/prices — USD prices for trade-lane tokens (Jupiter price v2).
 * Query: symbols=SOL,BUDJU,USDC,GLITCH (default: all allowed)
 */

import { type NextRequest, NextResponse } from "next/server";

import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  USDC_MINT_STR,
} from "@/lib/solana-config";
import { SOL_MINT, TRADE_ALLOWED_MINTS } from "@/lib/trade/jupiter-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SYMBOL_TO_MINT: Record<string, string> = {
  SOL: SOL_MINT,
  USDC: USDC_MINT_STR,
  BUDJU: BUDJU_TOKEN_MINT_STR,
  GLITCH: GLITCH_TOKEN_MINT_STR,
};

const MINT_TO_SYMBOL = Object.fromEntries(
  Object.entries(SYMBOL_TO_MINT).map(([s, m]) => [m, s]),
) as Record<string, string>;

async function fetchJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (!apiKey || mints.length === 0) return {};

  const url = `https://api.jup.ag/price/v2?ids=${mints.join(",")}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return {};

  const data = (await res.json()) as { data?: Record<string, { price?: string }> };
  const out: Record<string, number> = {};
  for (const mint of mints) {
    const p = data.data?.[mint]?.price;
    if (p) {
      const n = Number(p);
      if (Number.isFinite(n)) out[mint] = n;
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("symbols")?.trim();
  const symbols = raw
    ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : Object.keys(SYMBOL_TO_MINT);

  const mints: string[] = [];
  for (const sym of symbols) {
    const mint = SYMBOL_TO_MINT[sym];
    if (mint && TRADE_ALLOWED_MINTS.has(mint)) mints.push(mint);
  }

  if (mints.length === 0) {
    return NextResponse.json({ error: "No valid symbols" }, { status: 400 });
  }

  try {
    const byMint = await fetchJupiterPrices(mints);
    const prices: Record<string, number> = {};
    for (const [mint, usd] of Object.entries(byMint)) {
      const sym = MINT_TO_SYMBOL[mint];
      if (sym) prices[sym] = usd;
    }
    if (!prices.USDC && mints.includes(USDC_MINT_STR)) {
      prices.USDC = 1;
    }
    return NextResponse.json({ prices, asOf: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
