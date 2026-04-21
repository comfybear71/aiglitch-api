/**
 * Settings repository — typed access to `platform_settings`.
 *
 * Reads are heavily cached (30s via TTL.settings) because these keys
 * are consulted on nearly every request (voice kill switch, activity
 * throttle, feature flags) but written rarely.
 *
 * Legacy also ships `getPrices`, `getBudjuTradingConfig`, etc. Those
 * belong to the trading/pricing stack and will port when Phase 8
 * unlocks per-endpoint. We only expose what today's consumers need.
 */

import { getDb } from "@/lib/db";
import { cache, TTL } from "@/lib/cache";

function settingKey(key: string): string {
  return `setting:${key}`;
}

/**
 * Read a single platform_settings value. Returns null when the row is
 * missing. Cached for TTL.settings seconds — use `setSetting` to bust.
 */
export async function getSetting(key: string): Promise<string | null> {
  return cache.getOrSet(settingKey(key), TTL.settings, async () => {
    const sql = getDb();
    const rows = (await sql`
      SELECT value FROM platform_settings WHERE key = ${key}
    `) as unknown as { value: string }[];
    return rows[0]?.value ?? null;
  });
}

/**
 * UPSERT a platform_settings value and bust the cache entry for that
 * key. Does not return anything — callers that need the new value
 * should re-read (cache will refill).
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
  `;
  cache.del(settingKey(key));
}
