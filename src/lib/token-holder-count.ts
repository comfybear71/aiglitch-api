/**
 * SPL token holder count for market UI (BUDJU card on trade.aiglitch.app).
 * pump.fun is tried first; Helius DAS getTokenAccounts when pump.fun blocks datacenter IPs.
 */

import { HELIUS_API_KEY, getSolanaNetwork } from "@/lib/solana-config";

const CACHE_TTL_MS = 600_000;
const holderCache = new Map<string, { value: number; expiry: number }>();

function getCached(mint: string): number | null {
  const entry = holderCache.get(mint);
  if (entry && entry.expiry > Date.now()) return entry.value;
  return null;
}

function setCached(mint: string, value: number): void {
  holderCache.set(mint, { value, expiry: Date.now() + CACHE_TTL_MS });
}

async function fetchPumpFunHolderCount(mint: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      holder_count?: number;
      holders?: number;
      num_holders?: number;
    };
    const n = data.holder_count ?? data.holders ?? data.num_holders;
    if (n != null && Number.isFinite(n) && n >= 0) return Math.floor(n);
  } catch {
    /* fall through */
  }
  return null;
}

function heliusDasRpcUrl(): string | null {
  if (!HELIUS_API_KEY) return null;
  const network = getSolanaNetwork() === "mainnet-beta" ? "mainnet" : getSolanaNetwork();
  return `https://${network}.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
}

interface HeliusTokenAccountRow {
  owner?: string;
  amount?: number;
}

/** Unique wallets with a positive balance (paginated; capped for safety). */
export async function fetchHeliusUniqueHolderCount(mint: string): Promise<number | null> {
  const url = heliusDasRpcUrl();
  if (!url) return null;

  const owners = new Set<string>();
  let page = 1;
  const limit = 1000;
  const maxPages = 50;

  try {
    while (page <= maxPages) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `holders-${mint}-${page}`,
          method: "getTokenAccounts",
          params: { mint, page, limit, displayOptions: {} },
        }),
      });
      clearTimeout(timeoutId);

      if (!res.ok) return owners.size > 0 ? owners.size : null;

      const payload = (await res.json()) as {
        result?: { token_accounts?: HeliusTokenAccountRow[] };
        error?: unknown;
      };
      if (payload.error) return owners.size > 0 ? owners.size : null;

      const accounts = payload.result?.token_accounts ?? [];
      if (accounts.length === 0) break;

      for (const row of accounts) {
        if (!row.owner) continue;
        const amt = row.amount ?? 0;
        if (amt > 0) owners.add(row.owner);
      }

      if (accounts.length < limit) break;
      page += 1;
    }
  } catch {
    return owners.size > 0 ? owners.size : null;
  }

  return owners.size > 0 ? owners.size : null;
}

export async function fetchTokenHolderCount(mint: string): Promise<number | null> {
  const cached = getCached(mint);
  if (cached !== null) return cached;

  const fromPump = await fetchPumpFunHolderCount(mint);
  if (fromPump != null) {
    setCached(mint, fromPump);
    return fromPump;
  }

  const fromHelius = await fetchHeliusUniqueHolderCount(mint);
  if (fromHelius != null) {
    setCached(mint, fromHelius);
    return fromHelius;
  }

  return null;
}

/** Test-only: reset in-memory cache between vitest cases. */
export function _resetTokenHolderCountCacheForTests(): void {
  holderCache.clear();
}
