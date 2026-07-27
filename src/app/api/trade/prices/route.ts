/**
 * GET /api/trade/prices — USD prices for trade-lane tokens (Jupiter price v2 + quote fallback).
 * Query: symbols=SOL,BUDJU,USDC,GLITCH (default: all allowed)
 */

import { type NextRequest, NextResponse } from "next/server";

import { GLITCH_TOKEN_MINT_STR, USDC_MINT_STR } from "@/lib/solana-config";
import {
  SOL_MINT,
  TRADE_ALLOWED_MINTS,
  TRADE_MINT_DECIMALS,
  TRADE_MINT_TO_SYMBOL,
  TRADE_SYMBOL_TO_MINT,
} from "@/lib/trade/curated-markets";
import { fetchJupiterQuote } from "@/lib/trade/jupiter-client";
import { getOtcGlitchPriceUsd } from "@/lib/otc-bonding-curve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MINT_DECIMALS: Record<string, number> = TRADE_MINT_DECIMALS;

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
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(TRADE_SYMBOL_TO_MINT);

  const mints: string[] = [];
  for (const sym of symbols) {
    const mint =
      TRADE_SYMBOL_TO_MINT[sym.toUpperCase()] ??
      TRADE_SYMBOL_TO_MINT[sym];
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

    const byMint = jupiterMints.length > 0 ? await fetchJupiterPrices(jupiterMints) : {};
    const prices: Record<string, number> = {};

    for (const mint of mints) {
      const sym = TRADE_MINT_TO_SYMBOL[mint];
      if (!sym) continue;
      if (sym === "GLITCH") continue;
      let usd: number | undefined = byMint[mint];
      if (usd == null) {
        const fromQuote = await usdViaQuote(mint);
        if (fromQuote != null) usd = fromQuote;
      }
      if (usd != null && Number.isFinite(usd)) prices[sym] = usd;
    }

    if (wantsGlitch) {
      const otcUsd = await getOtcGlitchPriceUsd();
      if (otcUsd != null && Number.isFinite(otcUsd)) {
        prices.GLITCH = otcUsd;
      }
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
