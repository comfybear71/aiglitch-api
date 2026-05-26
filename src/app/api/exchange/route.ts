/**
 * /api/exchange — read-only market data + user balances.
 *
 * Port of legacy aiglitch/src/app/api/exchange/route.ts. Provides
 * market data for the exchange page (price, 24h change, liquidity,
 * tx counts) sourced from DexScreener / Jupiter, plus the user's
 * own token balances + trade history from in-DB tables. Audit-
 * confirmed simulation per the Phase 8 batch approval — zero
 * on-chain signing, zero treasury key access. External fetches
 * are READ-ONLY (DexScreener pair lookup, Jupiter price API).
 *
 * The POST is intentionally 410 Gone — direct trading was removed
 * in legacy. All real swaps now go through Jupiter on-chain via
 * Phantom from the exchange page (frontend-side).
 *
 * Endpoints:
 *   GET ?action=pairs        — list TRADING_PAIRS + TOKENS metadata
 *   GET ?action=balances&session_id=...
 *                             — user's GLITCH + SOL + USDC + BUDJU balances
 *   GET (no action) | ?action=market[&pair=GLITCH_USDC]
 *                             — full market envelope for the pair
 *   GET ?action=history&session_id=...
 *                             — user's exchange_orders rows
 *   POST                      — always 410 Gone
 *
 * Drops `ensureDbReady` per CLAUDE.md migration rule #4.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { TOKENS, TRADING_PAIRS } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Real mainnet mint addresses for the pair-lookup paths. Kept inline
// here (matches legacy) rather than imported from solana-config because
// these are MARKET-side identifiers that go to external aggregators —
// they shouldn't change with our internal Solana config.
const TOKEN_MINTS: Record<string, string> = {
  GLITCH: "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
  BUDJU:  "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump",
  SOL:    "So11111111111111111111111111111111111111112",
  USDC:   "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ── In-memory cache (30s TTL) ─────────────────────────────────────
// Matches legacy intent: throttle the external aggregator calls to
// keep within rate limits + avoid blocking page renders. Per-instance
// only (no Redis); good enough since each instance handles its own
// market reads independently.
const apiCache: Record<string, { data: unknown; expiry: number }> = {};

function getCached<T>(key: string): T | null {
  const entry = apiCache[key];
  if (entry && entry.expiry > Date.now()) return entry.data as T;
  return null;
}

function setCache(key: string, data: unknown, ttlMs = 30_000): void {
  apiCache[key] = { data, expiry: Date.now() + ttlMs };
}

// ── DexScreener types ─────────────────────────────────────────────
interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
}

async function fetchDexScreenerPairs(tokenMint: string): Promise<DexScreenerPair[]> {
  const cacheKey = `dex_${tokenMint}`;
  const cached = getCached<DexScreenerPair[]>(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { signal: controller.signal, headers: { Accept: "application/json" } },
    );
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const data = (await res.json()) as { pairs?: DexScreenerPair[] };
    const pairs = data.pairs ?? [];
    if (pairs.length > 0) setCache(cacheKey, pairs, 30_000);
    return pairs;
  } catch {
    return [];
  }
}

async function fetchJupiterPrice(tokenMint: string): Promise<number | null> {
  const cacheKey = `jup_${tokenMint}`;
  const cached = getCached<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMint}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Record<string, { price?: string }> };
    const priceStr = data?.data?.[tokenMint]?.price;
    if (priceStr) {
      const p = parseFloat(priceStr);
      setCache(cacheKey, p, 15_000);
      return p;
    }
    return null;
  } catch {
    return null;
  }
}

function findBestPair(
  pairs: DexScreenerPair[],
  baseMint: string,
  quoteMint: string,
): DexScreenerPair | null {
  const lower = (s: string) => s.toLowerCase();

  const exact = pairs.find(
    (p) =>
      lower(p.baseToken.address) === lower(baseMint) &&
      lower(p.quoteToken.address) === lower(quoteMint),
  );
  if (exact) return exact;

  // SOL can show up as wrapped SOL (WSOL) on DexScreener.
  if (quoteMint === TOKEN_MINTS.SOL) {
    const solPair = pairs.find(
      (p) =>
        lower(p.baseToken.address) === lower(baseMint) &&
        (p.quoteToken.symbol === "SOL" || p.quoteToken.symbol === "WSOL"),
    );
    if (solPair) return solPair;
  }

  // DexScreener sometimes lists the pair flipped (quote/base swapped).
  const reverse = pairs.find(
    (p) =>
      lower(p.baseToken.address) === lower(quoteMint) &&
      lower(p.quoteToken.address) === lower(baseMint),
  );
  if (reverse) return reverse;

  // Otherwise highest-liquidity pair for this base.
  return (
    pairs
      .filter((p) => lower(p.baseToken.address) === lower(baseMint))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null
  );
}

async function getStoredPrices(sql: ReturnType<typeof getDb>) {
  const keys = [
    "glitch_price_usd", "glitch_price_sol",
    "budju_price_usd",  "budju_price_sol",
    "sol_price_usd",
  ];
  const settings = (await sql`
    SELECT key, value FROM platform_settings WHERE key = ANY(${keys})
  `) as unknown as Array<{ key: string; value: string }>;

  const s: Record<string, string> = {};
  for (const row of settings) s[row.key] = row.value;

  return {
    GLITCH: { usd: parseFloat(s.glitch_price_usd ?? "0"), sol: parseFloat(s.glitch_price_sol ?? "0") },
    BUDJU:  { usd: parseFloat(s.budju_price_usd  ?? "0"), sol: parseFloat(s.budju_price_sol  ?? "0") },
    SOL:    { usd: parseFloat(s.sol_price_usd    ?? "164"), sol: 1 },
    USDC:   { usd: 1, sol: 1 / parseFloat(s.sol_price_usd ?? "164") },
  };
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  const sessionId = request.nextUrl.searchParams.get("session_id");
  const pairParam = request.nextUrl.searchParams.get("pair") ?? "GLITCH_USDC";

  const sql = getDb();

  if (action === "pairs") {
    return NextResponse.json({
      pairs: TRADING_PAIRS.filter((p) => p.isActive),
      tokens: Object.entries(TOKENS).map(([key, t]) => ({
        symbol: key,
        name: t.name,
        displaySymbol: t.symbol,
        iconEmoji: t.iconEmoji,
        color: t.color,
        mintAddress: t.mintAddress,
        meatBagBuyOnly: t.meatBagBuyOnly ?? false,
      })),
    });
  }

  if (action === "balances" && sessionId) {
    const glitchRows = (await sql`
      SELECT balance FROM glitch_coins WHERE session_id = ${sessionId}
    `) as unknown as Array<{ balance: number }>;
    const glitchBalance = glitchRows.length > 0 ? Number(glitchRows[0].balance) : 0;

    const walletRows = (await sql`
      SELECT sol_balance FROM solana_wallets
      WHERE owner_type = 'human' AND owner_id = ${sessionId}
    `) as unknown as Array<{ sol_balance: number }>;
    const solBalance = walletRows.length > 0 ? Number(walletRows[0].sol_balance) : 0;

    const tokenRows = (await sql`
      SELECT token, balance FROM token_balances
      WHERE owner_type = 'human' AND owner_id = ${sessionId}
    `) as unknown as Array<{ token: string; balance: number }>;

    const balances: Record<string, number> = {
      GLITCH: glitchBalance, SOL: solBalance, USDC: 0, BUDJU: 0,
    };
    for (const row of tokenRows) {
      if (row.token !== "GLITCH" && row.token !== "SOL") {
        balances[row.token] = Number(row.balance);
      }
    }
    return NextResponse.json({ balances });
  }

  if (action === "market" || !action) {
    const pair = TRADING_PAIRS.find((p) => p.id === pairParam);
    if (!pair) {
      return NextResponse.json({ error: "Invalid pair" }, { status: 400 });
    }

    const baseMint = TOKEN_MINTS[pair.base];
    const quoteMint = TOKEN_MINTS[pair.quote];
    const baseTokenConfig = TOKENS[pair.base];
    const quoteTokenConfig = TOKENS[pair.quote];

    // Source 1: DexScreener for full market data (base + quote in parallel).
    const needQuotePairs = pair.quote !== "SOL" && pair.quote !== "USDC";
    const [dexPairs, quotePairsResult] = await Promise.all([
      fetchDexScreenerPairs(baseMint),
      needQuotePairs ? fetchDexScreenerPairs(quoteMint) : Promise.resolve([]),
    ]);

    let dexPair: DexScreenerPair | null = null;
    if (dexPairs.length > 0) dexPair = findBestPair(dexPairs, baseMint, quoteMint);
    if (!dexPair && quotePairsResult.length > 0) {
      dexPair = findBestPair(quotePairsResult, baseMint, quoteMint);
    }

    let price = 0;
    let priceUsd = 0;
    let quotePriceUsd = 0;
    let change24h = 0;
    let volume24h = 0;
    let marketCap = 0;
    let liquidityUsd = 0;
    let liquidityBase = 0;
    let liquidityQuote = 0;
    let poolAddress = "";
    let dexName = "";
    let txns24h = { buys: 0, sells: 0 };
    let dataSource: "dexscreener" | "jupiter" | "stored" | "none" = "none";

    if (dexPair) {
      dataSource = "dexscreener";
      const isReversed =
        dexPair.baseToken.address.toLowerCase() !== baseMint.toLowerCase();

      priceUsd = parseFloat(dexPair.priceUsd ?? "0");
      change24h = dexPair.priceChange?.h24 ?? 0;
      volume24h = dexPair.volume?.h24 ?? 0;
      marketCap = dexPair.marketCap ?? dexPair.fdv ?? 0;
      liquidityUsd = dexPair.liquidity?.usd ?? 0;
      liquidityBase = dexPair.liquidity?.base ?? 0;
      liquidityQuote = dexPair.liquidity?.quote ?? 0;
      poolAddress = dexPair.pairAddress ?? "";
      dexName = dexPair.dexId ?? "";
      txns24h = dexPair.txns?.h24 ?? { buys: 0, sells: 0 };

      if (isReversed) {
        const dexPrice = parseFloat(dexPair.priceUsd ?? "0");
        priceUsd = dexPrice > 0 ? 1 / dexPrice : 0;
        change24h = -(dexPair.priceChange?.h24 ?? 0);
      }

      if (pair.quote === "USDC") {
        price = priceUsd;
        quotePriceUsd = 1;
      } else {
        const qMint = pair.quote === "SOL" ? TOKEN_MINTS.SOL : quoteMint;
        const fallback = pair.quote === "SOL" ? 164 : 0;
        quotePriceUsd = (await fetchJupiterPrice(qMint)) ?? fallback;
        price = quotePriceUsd > 0 ? priceUsd / quotePriceUsd : 0;
      }
    } else {
      // Source 2: Jupiter price API fallback (base + quote in parallel).
      const qMint = pair.quote === "USDC" ? null : pair.quote === "SOL" ? TOKEN_MINTS.SOL : quoteMint;
      const [jupBasePrice, jupQuotePrice] = await Promise.all([
        fetchJupiterPrice(baseMint),
        qMint ? fetchJupiterPrice(qMint) : Promise.resolve(null),
      ]);

      if (jupBasePrice !== null) {
        dataSource = "jupiter";
        priceUsd = jupBasePrice;

        if (pair.quote === "USDC") {
          quotePriceUsd = 1;
          price = priceUsd;
        } else {
          const fallback = pair.quote === "SOL" ? 164 : 0;
          quotePriceUsd = jupQuotePrice ?? fallback;
          price = quotePriceUsd > 0 ? priceUsd / quotePriceUsd : 0;
        }

        marketCap = priceUsd * (baseTokenConfig?.circulatingSupply ?? 0);
      } else {
        // Source 3: stored DB prices (offline-safe fallback).
        dataSource = "stored";
        const stored = await getStoredPrices(sql);
        const baseData = stored[pair.base as keyof typeof stored];
        const quoteData = stored[pair.quote as keyof typeof stored];

        priceUsd = baseData?.usd ?? 0;
        quotePriceUsd = quoteData?.usd ?? 1;
        price = quotePriceUsd > 0 ? priceUsd / quotePriceUsd : 0;
        marketCap = priceUsd * (baseTokenConfig?.circulatingSupply ?? 0);
      }
    }

    return NextResponse.json({
      pair_id: pair.id,
      pair: pair.label,
      base_token: pair.base,
      quote_token: pair.quote,
      base_icon: baseTokenConfig?.iconEmoji ?? "",
      quote_icon: quoteTokenConfig?.iconEmoji ?? "",
      price: parseFloat(price.toFixed(8)),
      price_usd: parseFloat(priceUsd.toFixed(8)),
      quote_price_usd: quotePriceUsd,
      change_24h: parseFloat(change24h.toFixed(2)),
      volume_24h: volume24h,
      market_cap: Math.round(marketCap),
      total_supply: baseTokenConfig?.totalSupply ?? 0,
      circulating_supply: baseTokenConfig?.circulatingSupply ?? 0,
      liquidity_usd: liquidityUsd,
      liquidity_base: liquidityBase,
      liquidity_quote: liquidityQuote,
      pool_address: poolAddress,
      dex_name: dexName,
      txns_24h: txns24h,
      data_source: dataSource,
      available_pairs: TRADING_PAIRS.filter((p) => p.isActive).map((p) => ({
        id: p.id,
        label: p.label,
        base: p.base,
        quote: p.quote,
      })),
    });
  }

  if (action === "history" && sessionId) {
    const orders = await sql`
      SELECT * FROM exchange_orders
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC LIMIT 50
    `;
    return NextResponse.json({ orders });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

/**
 * POST is intentionally gone. Direct trading was removed in legacy
 * (database-only swaps with simulated tx hashes are no longer
 * permitted). All real swaps now go through Jupiter on-chain via
 * Phantom from the exchange page.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Direct trading removed. Use the Jupiter swap on the exchange page for real on-chain swaps via Phantom.",
      redirect: "/exchange",
    },
    { status: 410 },
  );
}
