/**
 * GET /api/trade/prices — USD prices for trade-lane tokens (Jupiter price v2 + quote fallback).
 * Query: symbols=SOL,BUDJU,USDC,GLITCH (default: all allowed)
 */

import { type NextRequest, NextResponse } from "next/server";

import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  USDC_MINT_STR,
} from "@/lib/solana-config";
import {
  SOL_MINT,
  TRADE_ALLOWED_MINTS,
  fetchJupiterQuote,
} from "@/lib/trade/jupiter-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SYMBOL_TO_MINT: Record<string, string> = {
  SOL: SOL_MINT,
  USDC: USDC_MINT_STR,
  BUDJU: BUDJU_TOKEN_MINT_STR,
  GLITCH: GLITCH_TOKEN_MINT_STR,
};

const MINT_DECIMALS: Record<string, number> = {
  [SOL_MINT]: 9,
  [USDC_MINT_STR]: 6,
  [BUDJU_TOKEN_MINT_STR]: 6,
  [GLITCH_TOKEN_MINT_STR]: 9,
};

const MINT_TO_SYMBOL = Object.fromEntries(
  Object.entries(SYMBOL_TO_MINT).map(([s, m]) => [m, s]),
) as Record<string, string>;

function parseUsdFromPriceRow(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  for (const key of ["price", "usdPrice", "usd"]) {
    const v = r[key];
    if (v == null) continue;
    const n = typeof v === "string" ? Number(v) : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (!apiKey || mints.length === 0) return {};

  const url = `https://api.jup.ag/price/v3?ids=${mints.join(",")}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return {};

  const data = (await res.json()) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const mint of mints) {
    const row = data[mint] ?? (data.data as Record<string, unknown> | undefined)?.[mint];
    const usd = parseUsdFromPriceRow(row);
    if (usd != null) out[mint] = usd;
  }
  return out;
}

/** Implied USD per 1 token via a tiny USDC (or SOL→USDC) quote. */
async function usdViaQuote(mint: string): Promise<number | null> {
  if (mint === USDC_MINT_STR) return 1;
  try {
    if (mint === SOL_MINT) {
      const q = await fetchJupiterQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT_STR,
        amount: String(10 ** MINT_DECIMALS[SOL_MINT]),
        slippageBps: 100,
      });
      const outRaw = Number(q.outAmount);
      if (!Number.isFinite(outRaw) || outRaw <= 0) return null;
      return outRaw / 10 ** MINT_DECIMALS[USDC_MINT_STR];
    }
    const q = await fetchJupiterQuote({
      inputMint: USDC_MINT_STR,
      outputMint: mint,
      amount: String(10 ** MINT_DECIMALS[USDC_MINT_STR]),
      slippageBps: 100,
    });
    const outRaw = Number(q.outAmount);
    if (!Number.isFinite(outRaw) || outRaw <= 0) return null;
    const tokensOut = outRaw / 10 ** (MINT_DECIMALS[mint] ?? 6);
    return 1 / tokensOut;
  } catch {
    return null;
  }
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

    for (const mint of mints) {
      const sym = MINT_TO_SYMBOL[mint];
      if (!sym) continue;
      let usd: number | undefined = byMint[mint];
      if (usd == null) {
        const fromQuote = await usdViaQuote(mint);
        if (fromQuote != null) usd = fromQuote;
      }
      if (usd != null && Number.isFinite(usd)) prices[sym] = usd;
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
