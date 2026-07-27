/**
 * Trade-lane token display metadata: AIG!itch static icons + Jupiter Tokens API.
 */

import { TOKENS } from "@/lib/tokens";
import {
  TRADE_ALL_TOKEN_DEFS,
  TRADE_MINT_TO_SYMBOL,
  tradeMintFromSymbol,
} from "@/lib/trade/curated-markets";

export type TradeTokenMetaSource = "aiglitch" | "jupiter";

export interface TradeTokenMeta {
  symbol: string;
  mint: string;
  name: string;
  /** Relative path on trade.aiglitch.app (core tokens) or absolute Jupiter CDN URL. */
  iconUrl: string;
  iconEmoji: string;
  source: TradeTokenMetaSource;
}

const JUPITER_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const jupiterCache = new Map<string, { meta: TradeTokenMeta; expiresAt: number }>();

const CORE_SYMBOLS = new Set(["GLITCH", "BUDJU", "SOL", "USDC"]);

function coreMetaForSymbol(symbol: string, mint: string): TradeTokenMeta | null {
  const key = symbol.toUpperCase();
  if (!CORE_SYMBOLS.has(key)) return null;
  const t = TOKENS[key];
  if (!t) return null;
  return {
    symbol: key,
    mint,
    name: t.name,
    iconUrl: t.iconPath,
    iconEmoji: t.iconEmoji,
    source: "aiglitch",
  };
}

async function fetchJupiterMetaByMint(mint: string): Promise<TradeTokenMeta | null> {
  const cached = jupiterCache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;

  try {
    const res = await fetch(`${JUPITER_SEARCH}?query=${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { value?: unknown }).value)
        ? ((raw as { value: unknown[] }).value ?? [])
        : [];
    const row = list.find(
      (r) => r && typeof r === "object" && (r as { id?: string }).id === mint,
    ) as { id?: string; symbol?: string; name?: string; icon?: string } | undefined;
    if (!row?.icon?.trim()) return null;
    const symbol = TRADE_MINT_TO_SYMBOL[mint] ?? String(row.symbol ?? "").toUpperCase();
    const meta: TradeTokenMeta = {
      symbol,
      mint,
      name: String(row.name ?? symbol),
      iconUrl: row.icon.trim(),
      iconEmoji: symbol.slice(0, 1),
      source: "jupiter",
    };
    jupiterCache.set(mint, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
    return meta;
  } catch {
    return null;
  }
}

export async function resolveTradeTokenMetaForMint(mint: string): Promise<TradeTokenMeta | null> {
  const symbol = TRADE_MINT_TO_SYMBOL[mint];
  if (symbol) {
    const core = coreMetaForSymbol(symbol, mint);
    if (core) return core;
  }
  return fetchJupiterMetaByMint(mint);
}

/** Resolve metadata for trade symbols (e.g. JUP, GLITCH). Unknown symbols skipped. */
export async function resolveTradeTokenMetaForSymbols(
  symbols: string[],
): Promise<Record<string, TradeTokenMeta>> {
  const out: Record<string, TradeTokenMeta> = {};
  const mints = symbols
    .map((s) => tradeMintFromSymbol(s))
    .filter((m): m is string => m != null);
  await Promise.all(
    mints.map(async (mint) => {
      const meta = await resolveTradeTokenMetaForMint(mint);
      if (meta) out[meta.symbol] = meta;
    }),
  );
  return out;
}

/** All allowlisted trade tokens (core + curated Jupiter). */
export async function resolveAllTradeTokenMeta(): Promise<Record<string, TradeTokenMeta>> {
  const symbols = TRADE_ALL_TOKEN_DEFS.map((t) => t.symbol);
  return resolveTradeTokenMetaForSymbols(symbols);
}
