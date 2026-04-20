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
