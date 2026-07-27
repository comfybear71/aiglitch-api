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
  getSolanaNetwork,
  hasValidTokenMint,
} from "@/lib/solana-config";
import { DEVNET_USDC_MINT } from "@/lib/trade/magic-claim/config";

function usdcMintForNetwork(): string {
  return getSolanaNetwork() === "devnet" ? DEVNET_USDC_MINT : USDC_MINT_STR;
}

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

export async function fetchHeliusAddressBalances(
  walletAddress: string,
): Promise<HeliusBalanceResponse | null> {
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

function fetchHeliusBalances(walletAddress: string): Promise<HeliusBalanceResponse | null> {
  return fetchHeliusAddressBalances(walletAddress);
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
    usdc_balance: tokenAmount(tokens, usdcMintForNetwork(), USDC_DECIMALS),
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
        getSplBalance(usdcMintForNetwork(), USDC_DECIMALS),
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

/** Helius can lag minutes behind chain — take the higher of Helius vs RPC per field. */
function mergeWalletBalances(helius: WalletBalances, rpc: WalletBalances): WalletBalances {
  return {
    sol_balance: Math.max(helius.sol_balance, rpc.sol_balance),
    glitch_balance: Math.max(helius.glitch_balance, rpc.glitch_balance),
    budju_balance: Math.max(helius.budju_balance, rpc.budju_balance),
    usdc_balance: Math.max(helius.usdc_balance, rpc.usdc_balance),
  };
}

export async function getWalletBalances(walletAddress: string): Promise<WalletBalances> {
  if (!hasValidTokenMint()) return ZEROS;

  const heliusData = await fetchHeliusBalances(walletAddress);
  if (heliusData?.tokens) {
    const fromHelius = parseHelius(heliusData);
    if (heliusLooksUsable(heliusData, fromHelius)) {
      const fromRpc = await fetchRpcBalances(walletAddress);
      return mergeWalletBalances(fromHelius, fromRpc);
    }
  }

  return fetchRpcBalances(walletAddress);
}

export function heliusEnabled(): boolean {
  return !!process.env.HELIUS_API_KEY;
}
