/**
 * Helius-backed on-chain wallet balance reader.
 *
 * Port of the `getWalletBalances` helper from legacy
 * `aiglitch/src/app/api/solana/route.ts` (action=balance branch).
 *
 * **Helius-only by design.** The legacy code falls back to standard
 * Solana RPC + @solana/web3.js + @solana/spl-token when Helius is
 * unavailable. We don't drag those deps into aiglitch-api yet —
 * production has Helius configured, so the fallback path is cold
 * code in prod. If Helius is unreachable we return zeros and a
 * `helius_enabled: false` flag on the route response, so callers
 * can disambiguate "wallet is empty" from "we can't see it right now".
 *
 * If/when we need the RPC fallback (e.g. for local dev without a
 * Helius key, or as a real outage backstop), add @solana/web3.js +
 * @solana/spl-token and port the fallback block from legacy. Keep
 * the public shape of `getWalletBalances` the same.
 */

import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  HELIUS_API_KEY,
  USDC_MINT_STR,
  getHeliusApiUrl,
  hasValidTokenMint,
} from "@/lib/solana-config";

interface HeliusTokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  tokenAccount: string;
}

interface HeliusBalanceResponse {
  tokens: HeliusTokenBalance[];
  nativeBalance: number;
}

export interface WalletBalances {
  sol_balance: number;
  glitch_balance: number;
  budju_balance: number;
  usdc_balance: number;
}

const ZEROS: WalletBalances = {
  sol_balance: 0,
  glitch_balance: 0,
  budju_balance: 0,
  usdc_balance: 0,
};

// Helius fetch with an 8s timeout. Returns null on any failure
// so the caller can decide between zeros vs. raising an error.
async function fetchHeliusBalances(walletAddress: string): Promise<HeliusBalanceResponse | null> {
  const url = getHeliusApiUrl(`/v0/addresses/${walletAddress}/balances`);
  if (!url) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as HeliusBalanceResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// pump.fun tokens (incl. $BUDJU) use 6 decimals — distinct from §GLITCH's 9.
const GLITCH_DECIMALS = 9;
const BUDJU_DECIMALS = 6;
const USDC_DECIMALS = 6;

function tokenAmount(
  tokens: HeliusTokenBalance[],
  mint: string,
  fallbackDecimals: number,
): number {
  const token = tokens.find((t) => t.mint === mint);
  if (!token) return 0;
  const decimals = token.decimals || fallbackDecimals;
  return token.amount / Math.pow(10, decimals);
}

export async function getWalletBalances(walletAddress: string): Promise<WalletBalances> {
  if (!hasValidTokenMint()) return ZEROS;

  const data = await fetchHeliusBalances(walletAddress);
  if (!data) return ZEROS;

  return {
    sol_balance: data.nativeBalance / 1_000_000_000,
    glitch_balance: tokenAmount(data.tokens, GLITCH_TOKEN_MINT_STR, GLITCH_DECIMALS),
    budju_balance: tokenAmount(data.tokens, BUDJU_TOKEN_MINT_STR, BUDJU_DECIMALS),
    usdc_balance: tokenAmount(data.tokens, USDC_MINT_STR, USDC_DECIMALS),
  };
}

export function heliusEnabled(): boolean {
  return !!HELIUS_API_KEY;
}
