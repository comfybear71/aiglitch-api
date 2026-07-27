/**
 * Resolve USD price for trade-lane SPL mints (Jupiter v3 → v2 → quote → lite v3).
 */

import { USDC_MINT_STR } from "@/lib/solana-config";
import {
  SOL_MINT,
  TRADE_MINT_DECIMALS,
  TRADE_MINT_TO_SYMBOL,
} from "@/lib/trade/curated-markets";
import { fetchJupiterQuote } from "@/lib/trade/jupiter-client";

function parseUsdFromPriceRow(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  for (const key of ["usdPrice", "price", "usd"]) {
    const v = r[key];
    if (v == null) continue;
    const n = typeof v === "string" ? Number(v) : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchJupiterPricesV3(
  mints: string[],
  apiKey: string | null,
): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  const base = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const url = `${base}/price/v3?ids=${mints.join(",")}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
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

async function fetchJupiterPricesV2(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mints.join(",")}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { data?: Record<string, { price?: string }> };
    const out: Record<string, number> = {};
    for (const mint of mints) {
      const p = data.data?.[mint]?.price;
      if (p) {
        const n = parseFloat(p);
        if (Number.isFinite(n) && n > 0) out[mint] = n;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function usdViaQuotePair(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
}): Promise<number | null> {
  try {
    const q = await fetchJupiterQuote({
      ...params,
      slippageBps: 100,
      restrictIntermediateTokens: false,
    });
    const inRaw = Number(q.inAmount);
    const outRaw = Number(q.outAmount);
    if (!Number.isFinite(inRaw) || !Number.isFinite(outRaw) || inRaw <= 0 || outRaw <= 0) {
      return null;
    }
    if (params.outputMint === USDC_MINT_STR) {
      const tokensIn = inRaw / 10 ** (TRADE_MINT_DECIMALS[params.inputMint] ?? 6);
      const usdcOut = outRaw / 10 ** (TRADE_MINT_DECIMALS[USDC_MINT_STR] ?? 6);
      return usdcOut / tokensIn;
    }
    if (params.inputMint === USDC_MINT_STR) {
      const usdcIn = inRaw / 10 ** (TRADE_MINT_DECIMALS[USDC_MINT_STR] ?? 6);
      const tokensOut = outRaw / 10 ** (TRADE_MINT_DECIMALS[params.outputMint] ?? 6);
      return usdcIn / tokensOut;
    }
    if (params.outputMint === SOL_MINT) {
      const tokensIn = inRaw / 10 ** (TRADE_MINT_DECIMALS[params.inputMint] ?? 6);
      const solOut = outRaw / 10 ** (TRADE_MINT_DECIMALS[SOL_MINT] ?? 9);
      const solUsd = await resolveMintUsd(SOL_MINT, new Set());
      if (solUsd == null) return null;
      return (solOut / tokensIn) * solUsd;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve USD for one mint; `visiting` prevents SOL recursion loops. */
export async function resolveMintUsd(
  mint: string,
  visiting: Set<string> = new Set(),
): Promise<number | null> {
  if (mint === USDC_MINT_STR) return 1;
  if (visiting.has(mint)) return null;
  visiting.add(mint);

  const apiKey = process.env.JUPITER_API_KEY?.trim() || null;
  const decimals = TRADE_MINT_DECIMALS[mint] ?? 6;
  const oneUnit = String(10 ** decimals);

  const v3 = await fetchJupiterPricesV3([mint], apiKey);
  if (v3[mint] != null) return v3[mint];

  const lite = await fetchJupiterPricesV3([mint], null);
  if (lite[mint] != null) return lite[mint];

  const v2 = await fetchJupiterPricesV2([mint]);
  if (v2[mint] != null) return v2[mint];

  const sellForUsdc = await usdViaQuotePair({
    inputMint: mint,
    outputMint: USDC_MINT_STR,
    amount: oneUnit,
  });
  if (sellForUsdc != null) return sellForUsdc;

  const buyWithUsdc = await usdViaQuotePair({
    inputMint: USDC_MINT_STR,
    outputMint: mint,
    amount: String(10 ** (TRADE_MINT_DECIMALS[USDC_MINT_STR] ?? 6)),
  });
  if (buyWithUsdc != null) return buyWithUsdc;

  if (mint !== SOL_MINT) {
    const sellForSol = await usdViaQuotePair({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: oneUnit,
    });
    if (sellForSol != null) return sellForSol;
  }

  return null;
}

export async function resolveTradeSymbolPrices(
  mints: string[],
): Promise<Record<string, number>> {
  const apiKey = process.env.JUPITER_API_KEY?.trim() || null;
  const byMint: Record<string, number> = {
    ...(await fetchJupiterPricesV3(mints, apiKey)),
  };

  let missing = mints.filter((m) => byMint[m] == null && m !== USDC_MINT_STR);
  if (missing.length > 0) {
    Object.assign(byMint, await fetchJupiterPricesV3(missing, null));
    missing = missing.filter((m) => byMint[m] == null);
  }
  if (missing.length > 0) {
    Object.assign(byMint, await fetchJupiterPricesV2(missing));
    missing = missing.filter((m) => byMint[m] == null);
  }

  for (const mint of missing) {
    const usd = await resolveMintUsd(mint);
    if (usd != null) byMint[mint] = usd;
  }

  const prices: Record<string, number> = {};
  for (const mint of mints) {
    const sym = TRADE_MINT_TO_SYMBOL[mint];
    const usd = byMint[mint];
    if (sym && usd != null && Number.isFinite(usd)) prices[sym] = usd;
  }
  if (mints.includes(USDC_MINT_STR)) prices.USDC = 1;

  return prices;
}
