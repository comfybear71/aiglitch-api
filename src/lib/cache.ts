/**
 * Two-tier TTL cache.
 *   L1: in-memory Map (instant, per serverless instance)
 *   L2: Upstash Redis (persistent across deploys, shared across instances)
 *
 * Redis reads are capped via Promise.race so a slow Redis cannot block a
 * page render. Stale-while-revalidate serves expired L1 entries instantly
 * and refreshes them in the background. Redis writes are fire-and-forget.
 *
 * Without UPSTASH_REDIS_REST_URL set, the cache degrades to pure in-memory
 * (no L2). The behaviour is otherwise identical.
 */

import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;
let _redisChecked = false;

function getRedis(): Redis | null {
  if (_redisChecked) return _redis;
  _redisChecked = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      _redis = new Redis({ url, token });
    } catch (err) {
      console.warn("[cache] Failed to init Redis, using in-memory only:", err);
    }
  }
  return _redis;
}

const REDIS_PREFIX = "aiglitch:";
const REDIS_READ_TIMEOUT_MS = 150;
const STALE_GRACE_FACTOR = 2;
const SLOW_OP_THRESHOLD_MS = 100;

export interface CacheMetrics {
  l1Hits: number;
  l1Misses: number;
  l1StaleHits: number;
  l2Hits: number;
  l2Misses: number;
  l2Timeouts: number;
  l2Errors: number;
  computes: number;
  slowOps: number;
}

const metrics: CacheMetrics = {
  l1Hits: 0,
  l1Misses: 0,
  l1StaleHits: 0,
  l2Hits: 0,
  l2Misses: 0,
  l2Timeouts: 0,
  l2Errors: 0,
  computes: 0,
  slowOps: 0,
};

export function getCacheMetrics(): Readonly<CacheMetrics> {
  return { ...metrics };
}

export function resetCacheMetrics(): void {
  metrics.l1Hits = 0;
  metrics.l1Misses = 0;
  metrics.l1StaleHits = 0;
  metrics.l2Hits = 0;
  metrics.l2Misses = 0;
  metrics.l2Timeouts = 0;
  metrics.l2Errors = 0;
  metrics.computes = 0;
  metrics.slowOps = 0;
}

const TIMEOUT_SENTINEL = Symbol("timeout");

async function redisGetWithTimeout<T>(redis: Redis, key: string): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      redis.get<T>(key),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), REDIS_READ_TIMEOUT_MS),
      ),
    ]);

    if (result === TIMEOUT_SENTINEL) {
      metrics.l2Timeouts++;
      const elapsed = Date.now() - start;
      console.warn(`[cache] Redis read timed out after ${elapsed}ms for key: ${key}`);
      return null;
    }

    return result as T | null;
  } catch (err) {
    metrics.l2Errors++;
    const elapsed = Date.now() - start;
    console.warn(`[cache] Redis read failed after ${elapsed}ms:`, err);
    return null;
  }
}

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  ttlMs: number;
}

class TTLCache {
  private store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private revalidating = new Set<string>();

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.value as T;
  }

  private getStale<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now <= entry.expiresAt) return entry.value as T;
    const staleDeadline = entry.expiresAt + entry.ttlMs * STALE_GRACE_FACTOR;
    if (now > staleDeadline) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, ttlSeconds: number, value: T): void {
    if (this.store.size >= this.maxEntries) {
      this.evictExpired();
    }
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
      ttlMs: ttlSeconds * 1000,
    });
  }

  async getOrSet<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const opStart = Date.now();

    const l1 = this.get<T>(key);
    if (l1 !== null) {
      metrics.l1Hits++;
      return l1;
    }

    const stale = this.getStale<T>(key);
    if (stale !== null) {
      metrics.l1StaleHits++;
      this.revalidateInBackground(key, ttlSeconds, compute);
      return stale;
    }

    metrics.l1Misses++;

    const redis = getRedis();
    if (redis) {
      const l2 = await redisGetWithTimeout<T>(redis, `${REDIS_PREFIX}${key}`);
      if (l2 !== null && l2 !== undefined) {
        metrics.l2Hits++;
        this.set(key, ttlSeconds, l2);
        this.logSlowOp(opStart, key, "L2 hit");
        return l2;
      }
      metrics.l2Misses++;
    }

    metrics.computes++;
    const value = await compute();

    this.set(key, ttlSeconds, value);

    if (redis) {
      redis.set(`${REDIS_PREFIX}${key}`, value, { ex: ttlSeconds }).catch((err: unknown) => {
        console.warn("[cache] Redis write failed:", err);
      });
    }

    this.logSlowOp(opStart, key, "compute");
    return value;
  }

  del(key: string): boolean {
    const deleted = this.store.delete(key);
    const redis = getRedis();
    if (redis) {
      redis.del(`${REDIS_PREFIX}${key}`).catch((err: unknown) => {
        console.warn("[cache] Redis del failed:", err);
      });
    }
    return deleted;
  }

  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    const redis = getRedis();
    if (redis) {
      this.redisInvalidatePrefix(`${REDIS_PREFIX}${prefix}`).catch((err: unknown) => {
        console.warn("[cache] Redis prefix invalidate failed:", err);
      });
    }
    return count;
  }

  clear(): void {
    this.store.clear();
    this.revalidating.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private revalidateInBackground<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): void {
    if (this.revalidating.has(key)) return;
    this.revalidating.add(key);

    compute()
      .then((value) => {
        this.set(key, ttlSeconds, value);
        const redis = getRedis();
        if (redis) {
          redis.set(`${REDIS_PREFIX}${key}`, value, { ex: ttlSeconds }).catch((err: unknown) => {
            console.warn("[cache] Redis bg-write failed:", err);
          });
        }
      })
      .catch((err) => {
        console.warn(`[cache] Background revalidation failed for key "${key}":`, err);
      })
      .finally(() => {
        this.revalidating.delete(key);
      });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      const staleDeadline = entry.expiresAt + entry.ttlMs * STALE_GRACE_FACTOR;
      if (now > staleDeadline) {
        this.store.delete(key);
      }
    }
  }

  private async redisInvalidatePrefix(prefix: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    let cursor = "0";
    do {
      const result = (await redis.scan(cursor, { match: `${prefix}*`, count: 100 })) as [
        string,
        string[],
      ];
      cursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  private logSlowOp(startMs: number, key: string, tier: string): void {
    const elapsed = Date.now() - startMs;
    if (elapsed > SLOW_OP_THRESHOLD_MS) {
      metrics.slowOps++;
      console.warn(`[cache] Slow ${tier} for "${key}": ${elapsed}ms`);
    }
  }
}

export const cache = new TTLCache(500);

export const TTL = {
  personas: 120,
  persona: 60,
  settings: 30,
  prices: 15,
  feed: 10,
  tradingStats: 20,
  premiereCounts: 60,
} as const;
