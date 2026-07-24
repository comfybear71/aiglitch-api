/**
 * Helius-backed on-chain wallet balance reader with Solana RPC fallback.
 *
 * Production was returning all zeros when Helius `/v0/.../balances` fails
 * or returns an empty payload — port of legacy RPC fallback fixes trade gate.
 */

import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  USDC_MINT_STR,
  getHeliusApiUrl,
  getServerSolanaConnection,
  hasValidTokenMint,
} from "@/lib/solana-config";

interface HeliusTokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  tokenAccount: string;
}

interface HeliusBalanceResponse {
  tokens?: HeliusTokenBalance[];
  nativeBalance?: number;
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

const GLITCH_DECIMALS = 9;
const BUDJU_DECIMALS = 6;
const USDC_DECIMALS = 6;

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

function parseHelius(data: HeliusBalanceResponse): WalletBalances {
  const tokens = data.tokens ?? [];
  const native = Number(data.nativeBalance ?? 0);
  return {
    sol_balance: native / 1_000_000_000,
    glitch_balance: tokenAmount(tokens, GLITCH_TOKEN_MINT_STR, GLITCH_DECIMALS),
    budju_balance: tokenAmount(tokens, BUDJU_TOKEN_MINT_STR, BUDJU_DECIMALS),
    usdc_balance: tokenAmount(tokens, USDC_MINT_STR, USDC_DECIMALS),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function fetchRpcBalances(walletAddress: string): Promise<WalletBalances> {
  try {
    const connection = getServerSolanaConnection();
    const walletPubkey = new PublicKey(walletAddress);

    const getSplBalance = async (mintStr: string, decimals: number): Promise<number> => {
      try {
        const mint = new PublicKey(mintStr);
        const tokenAccount = await getAssociatedTokenAddress(mint, walletPubkey);
        const account = await getAccount(connection, tokenAccount);
        return Number(account.amount) / Math.pow(10, decimals);
      } catch {
        return 0;
      }
    };

    const results = await withTimeout(
      Promise.all([
        connection.getBalance(walletPubkey).catch(() => 0),
        getSplBalance(GLITCH_TOKEN_MINT_STR, GLITCH_DECIMALS),
        getSplBalance(BUDJU_TOKEN_MINT_STR, BUDJU_DECIMALS),
        getSplBalance(USDC_MINT_STR, USDC_DECIMALS),
      ]),
      12_000,
      [0, 0, 0, 0] as number[],
    );

    return {
      sol_balance: results[0] / 1_000_000_000,
      glitch_balance: results[1],
      budju_balance: results[2],
      usdc_balance: results[3],
    };
  } catch {
    return ZEROS;
  }
}

function heliusLooksUsable(data: HeliusBalanceResponse, parsed: WalletBalances): boolean {
  if (parsed.sol_balance > 0 || parsed.budju_balance > 0 || parsed.usdc_balance > 0 || parsed.glitch_balance > 0) {
    return true;
  }
  // Empty wallet is valid only when Helius returned explicit empty token list + zero native.
  if (Array.isArray(data.tokens) && data.nativeBalance === 0) return true;
  return false;
}

export async function getWalletBalances(walletAddress: string): Promise<WalletBalances> {
  if (!hasValidTokenMint()) return ZEROS;

  const heliusData = await fetchHeliusBalances(walletAddress);
  if (heliusData?.tokens) {
    const fromHelius = parseHelius(heliusData);
    if (heliusLooksUsable(heliusData, fromHelius)) return fromHelius;
  }

  return fetchRpcBalances(walletAddress);
}

export function heliusEnabled(): boolean {
  return !!process.env.HELIUS_API_KEY;
}
