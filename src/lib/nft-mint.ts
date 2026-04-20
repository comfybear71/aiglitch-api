/**
 * Slim NFT pricing + rarity helpers used by `/api/nft/image` +
 * `/api/nft/metadata`.
 *
 * The full legacy `@/lib/nft-mint` (543 LOC) builds Solana mint
 * transactions with `@solana/web3.js` + `@solana/spl-token` +
 * `@metaplex-foundation/mpl-token-metadata`. None of that is needed
 * to render a card or serve metadata JSON. The transaction-building
 * surface ports with Phase 8 trading.
 */

const RARITY_THRESHOLDS = {
  legendary: 200,
  epic: 100,
  rare: 50,
  uncommon: 25,
} as const;

const RARITY_COLORS: Record<string, string> = {
  legendary: "#FFD700",
  epic: "#A855F7",
  rare: "#3B82F6",
  uncommon: "#22C55E",
  common: "#9CA3AF",
};

export function getRarity(price: number): string {
  if (price >= RARITY_THRESHOLDS.legendary) return "legendary";
  if (price >= RARITY_THRESHOLDS.epic) return "epic";
  if (price >= RARITY_THRESHOLDS.rare) return "rare";
  if (price >= RARITY_THRESHOLDS.uncommon) return "uncommon";
  return "common";
}

export function rarityColor(rarity: string): string {
  return RARITY_COLORS[rarity] ?? RARITY_COLORS.common!;
}

/** Parse a GLITCH price string like "§69" or "69" → 69 (ceil'd). */
export function parseCoinPrice(priceStr: string): number {
  return Math.ceil(parseFloat(priceStr.replace("§", "")));
}
