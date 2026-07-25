import bs58 from "bs58";
import { randomBytes } from "crypto";

import { DEVNET_USDC_MINT } from "@/lib/trade/magic-claim/config";
import { getSolanaNetwork } from "@/lib/solana-config";
import { tradeMintFromSymbol } from "@/lib/trade/build-transfer";

export function newClaimIdBase58(): { id: string; bytes: Buffer } {
  const bytes = randomBytes(16);
  return { id: bs58.encode(bytes), bytes };
}

export function decodeClaimIdBase58(id: string): Buffer {
  const bytes = bs58.decode(id);
  if (bytes.length !== 16) throw new Error("Invalid claim id");
  return Buffer.from(bytes);
}

export function resolveMagicLinkMint(symbol: string): string | null {
  const sym = symbol.toUpperCase();
  if (getSolanaNetwork() === "devnet" && sym === "USDC") {
    return DEVNET_USDC_MINT;
  }
  return tradeMintFromSymbol(sym);
}
