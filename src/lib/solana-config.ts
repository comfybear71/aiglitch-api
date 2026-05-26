/**
 * Solana config for token-metadata reads + Helius balance lookups +
 * Phase 8 future write paths.
 *
 * Used to be a string-only "slim" file. Now also exposes
 * `getServerSolanaConnection()` and re-exports a small surface from
 * `@solana/web3.js` so future Phase 8 admin route ports (NFT mint
 * reads, wallet keypair handling, etc.) don't each have to wire up
 * their own RPC client. Web3.js + spl-token were added opportunistically
 * in v1.18.x even though no in-tree consumer needs them yet — the
 * cost is ~8s of cold-start import work, the benefit is half a session
 * cut off each future Phase 8 admin port.
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

import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

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

// "mainnet-beta" | "devnet" | "testnet" — defaults match the env-bible schema.
export type SolanaNetwork = "mainnet-beta" | "devnet" | "testnet";
export function getSolanaNetwork(): SolanaNetwork {
  const raw = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  if (raw === "devnet" || raw === "testnet" || raw === "mainnet-beta") return raw;
  return "mainnet-beta";
}

export function getHeliusApiUrl(path: string): string | null {
  if (!HELIUS_API_KEY) return null;
  return `https://api.helius.xyz${path}?api-key=${HELIUS_API_KEY}`;
}

// Builds a Helius RPC URL for server-side Connection use.
// Returns null when no Helius key is configured; callers can fall
// back to the public clusterApiUrl in that case.
function buildHeliusRpcUrl(): string | null {
  if (!HELIUS_API_KEY) return null;
  const network = getSolanaNetwork() === "mainnet-beta" ? "mainnet" : getSolanaNetwork();
  return `https://${network}.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
}

// Server-side connection (Helius if available; public RPC fallback —
// never use the fallback on the client because the public endpoints
// are heavily rate-limited). Cached after first call.
let _serverConnection: Connection | null = null;
export function getServerSolanaConnection(): Connection {
  if (_serverConnection) return _serverConnection;
  const url =
    buildHeliusRpcUrl() ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    clusterApiUrl(getSolanaNetwork());
  _serverConnection = new Connection(url, "confirmed");
  return _serverConnection;
}

// Lazy PublicKey helpers — avoid throwing at import time if a mint
// env var is unset, surface the error at first call instead.
let _glitchMintPubkey: PublicKey | null = null;
export function getGlitchTokenMint(): PublicKey {
  if (!_glitchMintPubkey) _glitchMintPubkey = new PublicKey(GLITCH_TOKEN_MINT_STR);
  return _glitchMintPubkey;
}

let _budjuMintPubkey: PublicKey | null = null;
export function getBudjuTokenMint(): PublicKey {
  if (!_budjuMintPubkey) _budjuMintPubkey = new PublicKey(BUDJU_TOKEN_MINT_STR);
  return _budjuMintPubkey;
}

let _treasuryPubkey: PublicKey | null = null;
export function getTreasuryWallet(): PublicKey {
  if (!_treasuryPubkey) _treasuryPubkey = new PublicKey(TREASURY_WALLET_STR);
  return _treasuryPubkey;
}

let _adminPubkey: PublicKey | null = null;
export function getAdminWallet(): PublicKey {
  if (!_adminPubkey) _adminPubkey = new PublicKey(ADMIN_WALLET_STR);
  return _adminPubkey;
}

// Token mint is "valid" when it's not the system-program placeholder.
export function hasValidTokenMint(): boolean {
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  return GLITCH_TOKEN_MINT_STR !== SYSTEM_PROGRAM && GLITCH_TOKEN_MINT_STR.length > 10;
}

// Base58 alphabet, 32-44 chars. Cheap pre-check before constructing
// a PublicKey when input came from a query string / request body.
export function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// Metaplex Token Metadata Program — the on-chain program that owns the
// `name`/`symbol`/`uri`/`image` metadata Phantom and other wallets read.
// Used by /api/admin/token-metadata to attach/update §GLITCH info.
export const TOKEN_METADATA_PROGRAM_ID_STR =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

let _tokenMetadataProgramId: PublicKey | null = null;
export function getTokenMetadataProgramId(): PublicKey {
  if (!_tokenMetadataProgramId) {
    _tokenMetadataProgramId = new PublicKey(TOKEN_METADATA_PROGRAM_ID_STR);
  }
  return _tokenMetadataProgramId;
}

// Derive the Metaplex metadata PDA (program-derived address) for a mint.
// Same byte layout as Metaplex's @metaplex-foundation/mpl-token-metadata
// — kept inline to avoid pulling the whole MPL SDK for this single use.
export function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      getTokenMetadataProgramId().toBuffer(),
      mint.toBuffer(),
    ],
    getTokenMetadataProgramId(),
  );
  return pda;
}

// True only when NEXT_PUBLIC_SOLANA_REAL_MODE='true' AND a non-placeholder
// token mint is configured. Used to gate code paths that touch real
// treasury keys (e.g. bridge claim → treasury service hand-off).
export function isRealSolanaMode(): boolean {
  return (
    process.env.NEXT_PUBLIC_SOLANA_REAL_MODE === "true" &&
    hasValidTokenMint()
  );
}
