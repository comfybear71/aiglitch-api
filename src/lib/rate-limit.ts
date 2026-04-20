/**
 * In-memory sliding-window rate limiter.
 *
 * Zero-dependency. Module-level Map survives within a warm Lambda
 * instance; cold starts reset. Legacy treats this as best-effort —
 * preserved here rather than introducing Redis, same as the existing
 * `/api/sponsor/inquiry` pattern.
 *
 * Periodic cleanup (every 5 min) prunes stale keys so the Map
 * doesn't grow unbounded on long-lived instances.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimiterConfig {
  /** Max attempts allowed in the window. */
  maxAttempts: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the window reset for the caller's key. */
  resetMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  /** Wipe a single key — used after successful auth so only failures count. */
  reset(key: string): void;
  /** Wipe every entry. Test helper. */
  clear(): void;
}

const CLEANUP_INTERVAL = 5 * 60 * 1000;

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const store = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();

  function cleanup(): void {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;
    const cutoff = now - config.windowMs;
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }

  function check(key: string): RateLimitResult {
    cleanup();
    const now = Date.now();
    const cutoff = now - config.windowMs;

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= config.maxAttempts) {
      const oldest = entry.timestamps[0]!;
      return {
        allowed: false,
        remaining: 0,
        resetMs: oldest + config.windowMs - now,
      };
    }

    entry.timestamps.push(now);
    return {
      allowed: true,
      remaining: config.maxAttempts - entry.timestamps.length,
      resetMs: config.windowMs,
    };
  }

  function reset(key: string): void {
    store.delete(key);
  }

  function clear(): void {
    store.clear();
  }

  return { check, reset, clear };
}

/** Admin login: 5 attempts per IP per 15 minutes. */
export const adminLoginLimiter = createRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});

/** Cron endpoint: 30 requests per endpoint per 5 minutes. Used when Phase 6 lands. */
export const cronEndpointLimiter = createRateLimiter({
  maxAttempts: 30,
  windowMs: 5 * 60 * 1000,
});

/** Public API: 120 requests per IP per minute. Available for future routes that need it. */
export const publicApiLimiter = createRateLimiter({
  maxAttempts: 120,
  windowMs: 60 * 1000,
});
