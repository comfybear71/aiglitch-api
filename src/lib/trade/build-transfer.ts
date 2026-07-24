/**
 * Build unsigned SPL / SOL transfer for trade.aiglitch.app Send (Phantom signs client-side).
 */

import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { getServerSolanaConnection } from "@/lib/solana-config";
import {
  BUDJU_TOKEN_MINT_STR,
  GLITCH_TOKEN_MINT_STR,
  USDC_MINT_STR,
} from "@/lib/solana-config";
import { assertAllowedMint, TRADE_ALLOWED_MINTS } from "@/lib/trade/jupiter-client";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const MINT_DECIMALS: Record<string, number> = {
  [SOL_MINT]: 9,
  [USDC_MINT_STR]: 6,
  [BUDJU_TOKEN_MINT_STR]: 6,
  [GLITCH_TOKEN_MINT_STR]: 9,
};

export function mintDecimals(mint: string): number {
  return MINT_DECIMALS[mint] ?? 9;
}

export function isNativeSolMint(mint: string): boolean {
  return mint === SOL_MINT;
}

export async function buildTradeTransferTransaction(params: {
  fromPublicKey: string;
  toPublicKey: string;
  /** Mint pubkey or SOL native mint */
  mint: string;
  /** Smallest units (lamports for SOL) */
  amountAtomic: string;
}): Promise<{ transaction: string }> {
  const mint = params.mint.trim();
  assertAllowedMint(mint);

  const amount = BigInt(params.amountAtomic);
  if (amount <= 0n) throw new Error("Amount must be positive");

  const from = new PublicKey(params.fromPublicKey);
  const to = new PublicKey(params.toPublicKey);
  if (from.equals(to)) throw new Error("Cannot send to yourself");

  const connection = getServerSolanaConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const instructions = [];

  if (isNativeSolMint(mint)) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports: amount,
      }),
    );
  } else {
    const mintPk = new PublicKey(mint);
    const decimals = mintDecimals(mint);
    const fromAta = getAssociatedTokenAddressSync(mintPk, from);
    const toAta = getAssociatedTokenAddressSync(mintPk, to);
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, mintPk),
      createTransferCheckedInstruction(fromAta, mintPk, toAta, from, amount, decimals),
    );
  }

  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  return { transaction: serialized };
}

/** Symbol → mint for API validation */
export function tradeMintFromSymbol(symbol: string): string | null {
  const map: Record<string, string> = {
    SOL: SOL_MINT,
    USDC: USDC_MINT_STR,
    BUDJU: BUDJU_TOKEN_MINT_STR,
    GLITCH: GLITCH_TOKEN_MINT_STR,
  };
  const m = map[symbol.toUpperCase()];
  if (!m || !TRADE_ALLOWED_MINTS.has(m)) return null;
  return m;
}
