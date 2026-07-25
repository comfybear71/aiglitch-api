/**
 * Magic link escrow — devnet-first (7d expiry, $500 cap, cancel anytime refund).
 */

import { getSolanaNetwork } from "@/lib/solana-config";

/** Circle USDC on Solana devnet */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const MAGIC_LINK_EXPIRY_SEC = 7 * 24 * 60 * 60;
export const MAGIC_LINK_MAX_USD = 500;
export const CLAIM_ID_BYTE_LEN = 16;

export function getTradeAppBaseUrl(): string {
  return process.env.NEXT_PUBLIC_TRADE_APP_URL?.trim() || "https://trade.aiglitch.app";
}

export function getMagicClaimProgramId(): string | null {
  const id = process.env.TRADE_MAGIC_CLAIM_PROGRAM_ID?.trim();
  return id || null;
}

/** Requires program id; on devnet always allowed once deployed; mainnet needs explicit flag. */
export function isMagicLinkEnabled(): boolean {
  if (!getMagicClaimProgramId()) return false;
  if (getSolanaNetwork() === "devnet") return true;
  return process.env.TRADE_MAGIC_LINK_ENABLED === "true";
}

/** v1 devnet: USDC only. Mainnet: trade-lane SPL (no native SOL until program upgrade). */
export function magicLinkSymbolsAllowed(): string[] {
  if (getSolanaNetwork() === "devnet") return ["USDC"];
  return ["USDC", "BUDJU", "GLITCH"];
}

export function claimUrl(claimIdBase58: string): string {
  return `${getTradeAppBaseUrl()}/claim/${claimIdBase58}`;
}
