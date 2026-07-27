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
  SOL_MINT,
  TRADE_MINT_DECIMALS,
  tradeMintFromSymbol,
} from "@/lib/trade/curated-markets";
import { assertAllowedMint } from "@/lib/trade/jupiter-client";
import { DEVNET_USDC_MINT } from "@/lib/trade/magic-claim/config";

const MINT_DECIMALS: Record<string, number> = {
  ...TRADE_MINT_DECIMALS,
  [DEVNET_USDC_MINT]: 6,
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

export { tradeMintFromSymbol };
