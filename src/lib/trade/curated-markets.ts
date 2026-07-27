/**
 * Curated Jupiter majors for trade.aiglitch.app (swap allowlist + Markets grid).
 * Keep trading-aiglitch src/lib/trade-tokens.ts in sync.
 */

import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  USDC_MINT_STR,
} from "@/lib/solana-config";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface TradeTokenDef {
  symbol: string;
  mint: string;
  decimals: number;
  /** Default quote when user taps Buy on Markets */
  defaultQuote: "USDC" | "SOL";
  /** Liquid staking token — staking yield (not Jupiter Earn deposit UI) */
  yieldLst?: boolean;
  jupiterMajor?: boolean;
}

/** Core ecosystem lane (OTC + gate). */
export const TRADE_CORE_TOKENS: TradeTokenDef[] = [
  { symbol: "SOL", mint: SOL_MINT, decimals: 9, defaultQuote: "USDC" },
  { symbol: "USDC", mint: USDC_MINT_STR, decimals: 6, defaultQuote: "SOL" },
  { symbol: "BUDJU", mint: BUDJU_TOKEN_MINT_STR, decimals: 6, defaultQuote: "USDC" },
  { symbol: "GLITCH", mint: GLITCH_TOKEN_MINT_STR, decimals: 9, defaultQuote: "USDC" },
];

/** Top Jupiter pairs — majors + LSTs (Phase 1; Earn/Lend deferred). */
export const TRADE_CURATED_JUPITER_TOKENS: TradeTokenDef[] = [
  {
    symbol: "JUP",
    mint: "JUPyiwrYJFskUPkHLfU6WH9tFQ12GYCZqFFoBoF7qK",
    decimals: 6,
    defaultQuote: "USDC",
    jupiterMajor: true,
  },
  {
    symbol: "WIF",
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    decimals: 6,
    defaultQuote: "USDC",
    jupiterMajor: true,
  },
  {
    symbol: "BONK",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    decimals: 5,
    defaultQuote: "USDC",
    jupiterMajor: true,
  },
  {
    symbol: "RAY",
    mint: "4k3Dyjzvzp8eMZWUXbBCjJ7zCkQTJGFaW5dCxM8DrUgen",
    decimals: 6,
    defaultQuote: "USDC",
    jupiterMajor: true,
  },
  {
    symbol: "PYTH",
    mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    decimals: 6,
    defaultQuote: "USDC",
    jupiterMajor: true,
  },
  {
    symbol: "jupSOL",
    mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    decimals: 9,
    defaultQuote: "SOL",
    yieldLst: true,
    jupiterMajor: true,
  },
  {
    symbol: "mSOL",
    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    decimals: 9,
    defaultQuote: "SOL",
    yieldLst: true,
    jupiterMajor: true,
  },
];

export const TRADE_ALL_TOKEN_DEFS: TradeTokenDef[] = [
  ...TRADE_CORE_TOKENS,
  ...TRADE_CURATED_JUPITER_TOKENS,
];

export const TRADE_ALLOWED_MINTS = new Set(TRADE_ALL_TOKEN_DEFS.map((t) => t.mint));

export const TRADE_SYMBOL_TO_MINT: Record<string, string> = Object.fromEntries(
  TRADE_ALL_TOKEN_DEFS.map((t) => [t.symbol.toUpperCase(), t.mint]),
);

export const TRADE_MINT_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  TRADE_ALL_TOKEN_DEFS.map((t) => [t.mint, t.symbol]),
);

export const TRADE_MINT_DECIMALS: Record<string, number> = Object.fromEntries(
  TRADE_ALL_TOKEN_DEFS.map((t) => [t.mint, t.decimals]),
);

export function tradeMintFromSymbol(symbol: string): string | null {
  const mint = TRADE_SYMBOL_TO_MINT[symbol.trim().toUpperCase()];
  if (!mint || !TRADE_ALLOWED_MINTS.has(mint)) return null;
  return mint;
}

/** OTC §GLITCH checkout — SOL only until treasury milestone (5k SOL). */
export const OTC_CHECKOUT_PAYMENT_ASSETS = ["SOL"] as const;
export const OTC_TREASURY_LISTING_GOAL_SOL = 5000;
