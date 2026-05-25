/**
 * Slim Solana config for the token-metadata endpoints.
 *
 * The full legacy `@/lib/solana-config` bundles Helius RPC wiring,
 * @solana/web3.js PublicKey parsing, and several program IDs. Only
 * string constants are needed for `/api/token/*` — the rest ports
 * later when real Solana read/write paths land (Phase 8 trading,
 * Phase 5 AI engine wallet reads, etc.).
 *
 * Every value has a fallback so this repo boots even when no Solana
 * env vars are set. The fallbacks are the public mainnet addresses
 * legacy ships with (on-chain, discoverable — not secrets).
 *
 * **Base URL gotcha.** `getAppBaseUrl()` defaults to
 * `https://aiglitch.app` rather than `https://api.aiglitch.app`.
 * Aggregators (Jupiter, DexScreener, CoinGecko) cache the token
 * metadata URI baked into on-chain Metaplex data. That URI still
 * points at `aiglitch.app`, and the consumer frontend proxies
 * `/api/token/*` back to this backend via the beforeFiles rewrite.
 * If we returned `api.aiglitch.app` in the metadata JSON, aggregator
 * caches would drift out of sync. Override via `NEXT_PUBLIC_APP_URL`
 * if the token metadata URI ever changes on-chain.
 */

export function getAppBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "https://aiglitch.app";
}

export const GLITCH_TOKEN_MINT_STR =
  process.env.NEXT_PUBLIC_GLITCH_TOKEN_MINT ??
  "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT";

export const TREASURY_WALLET_STR =
  process.env.NEXT_PUBLIC_TREASURY_WALLET ??
  "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56";

export const ADMIN_WALLET_STR =
  process.env.NEXT_PUBLIC_ADMIN_WALLET ??
  "2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ";

export const METEORA_GLITCH_SOL_POOL =
  process.env.NEXT_PUBLIC_METEORA_GLITCH_SOL_POOL ??
  "GWBsH6aArjdwmX8zUaiPdDke1nA7pLLe9x9b1kuHpsGV";

export const BUDJU_TOKEN_MINT_STR =
  process.env.NEXT_PUBLIC_BUDJU_TOKEN_MINT ??
  "2ajYe8eh8btUZRpaZ1v7ewWDkcYJmVGvPuDTU5xrpump";

// USDC SPL mint on Solana mainnet.
export const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? "";

export function getHeliusApiUrl(path: string): string | null {
  if (!HELIUS_API_KEY) return null;
  return `https://api.helius.xyz${path}?api-key=${HELIUS_API_KEY}`;
}

// Token mint is "valid" when it's not the system-program placeholder.
export function hasValidTokenMint(): boolean {
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  return GLITCH_TOKEN_MINT_STR !== SYSTEM_PROGRAM && GLITCH_TOKEN_MINT_STR.length > 10;
}

// Base58 alphabet, 32-44 chars. Avoids pulling @solana/web3.js just to validate input.
export function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}
