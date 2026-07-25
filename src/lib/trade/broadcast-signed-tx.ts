/**
 * Broadcast a Phantom-signed versioned transaction via server Helius RPC.
 * Browsers must not use api.mainnet-beta.solana.com (403 Access forbidden).
 */

import { VersionedTransaction } from "@solana/web3.js";

import { getServerSolanaConnection } from "@/lib/solana-config";

const MAX_TX_BYTES = 2048;

export async function broadcastSignedVersionedTransaction(
  signedTransactionBase64: string,
): Promise<{ signature: string }> {
  const raw = Buffer.from(signedTransactionBase64.trim(), "base64");
  if (raw.length === 0 || raw.length > MAX_TX_BYTES) {
    throw new Error("Invalid signed transaction payload");
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch {
    throw new Error("Could not deserialize signed transaction");
  }

  if (!tx.signatures?.length || tx.signatures.every((s) => s.every((b) => b === 0))) {
    throw new Error("Transaction is not signed");
  }

  const connection = getServerSolanaConnection();
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return { signature };
}
