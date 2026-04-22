/**
 * Upstash Redis credentials resolution.
 *
 * Vercel's Upstash integration auto-injects env vars using Vercel's own
 * naming (`KV_REST_API_URL` / `KV_REST_API_TOKEN`). Our historical code
 * reads the Upstash-native naming (`UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN`). This helper transparently accepts either,
 * preferring the Upstash-native names when both happen to be set.
 *
 * Returns null when neither naming convention has both url + token set.
 * Callers should treat null as "Redis not configured" and fall back to
 * their local/in-memory path — our platform is explicitly fail-open per
 * CLAUDE.md.
 *
 * Both `KV_URL` and `REDIS_URL` (connection-string flavours) are ignored
 * here — we only care about the REST API credentials because that's what
 * `@upstash/redis` uses.
 */

export interface UpstashCredentials {
  url: string;
  token: string;
  /** Which naming convention we resolved from — useful for diagnostics. */
  source: "upstash" | "vercel-kv";
}

export function getUpstashCredentials(): UpstashCredentials | null {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (upstashUrl && upstashToken) {
    return { url: upstashUrl, token: upstashToken, source: "upstash" };
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    return { url: kvUrl, token: kvToken, source: "vercel-kv" };
  }

  return null;
}
