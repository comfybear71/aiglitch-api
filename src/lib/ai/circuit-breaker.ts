/**
 * Redis-backed per-provider circuit breaker.
 *
 * States:
 *   CLOSED   — normal; calls go through
 *   OPEN     — failure threshold exceeded; calls are rejected until cooldown expires
 *   HALF_OPEN — cooldown elapsed; one probe call goes through to test recovery
 *
 * Fail-open rule (safety rule 7): if Redis is unavailable, all calls proceed.
 * State is best-effort. Cold Lambda starts reset all state.
 */

import { Redis } from "@upstash/redis";
import type { AiProvider } from "./types";

export type CircuitState = "closed" | "open" | "half_open";

export interface BreakerConfig {
  /** Number of failures in the window to trip the breaker. */
  failureThreshold: number;
  /** Sliding window for counting failures (ms). */
  windowMs: number;
  /** How long the breaker stays OPEN before moving to HALF_OPEN (ms). */
  cooldownMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 60_000,
};

let _redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (_redis === undefined) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    _redis = url && token ? new Redis({ url, token }) : null;
  }
  return _redis;
}

function openUntilKey(provider: AiProvider): string {
  return `cb:${provider}:open_until`;
}

function failuresKey(provider: AiProvider): string {
  return `cb:${provider}:failures`;
}

export async function getCircuitState(
  provider: AiProvider,
  _config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): Promise<CircuitState> {
  const redis = getRedis();
  if (!redis) return "closed"; // fail-open

  try {
    const openUntil = await redis.get<number>(openUntilKey(provider));
    if (!openUntil) return "closed";
    return Date.now() < openUntil ? "open" : "half_open";
  } catch {
    return "closed"; // fail-open on Redis error
  }
}

export async function canProceed(
  provider: AiProvider,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): Promise<boolean> {
  const state = await getCircuitState(provider, config);
  return state !== "open";
}

export async function recordSuccess(provider: AiProvider): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await Promise.all([
      redis.del(openUntilKey(provider)),
      redis.del(failuresKey(provider)),
    ]);
  } catch {
    /* fail-open */
  }
}

export async function recordFailure(
  provider: AiProvider,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const key = failuresKey(provider);
    const failures = await redis.incr(key);
    // Keep the key alive for the full window
    await redis.expire(key, Math.ceil(config.windowMs / 1000));

    if (failures >= config.failureThreshold) {
      const openUntil = Date.now() + config.cooldownMs;
      // TTL is 2× cooldown so stale open_until keys self-expire
      await redis.set(openUntilKey(provider), openUntil, {
        px: config.cooldownMs * 2,
      });
    }
  } catch {
    /* fail-open */
  }
}

/** Reset Redis singleton — test helper only. */
export function __resetBreakerClient(): void {
  _redis = undefined;
}

export interface BreakerStatus {
  xai: CircuitState;
  anthropic: CircuitState;
  /** true when Redis is not configured — breakers fail-open and the
   *  returned states are always "closed", which is not a real signal. */
  redisAvailable: boolean;
}

/**
 * Per-provider breaker snapshot for the admin dashboard. Returns
 * "closed" for every provider when Redis isn't configured (fail-open),
 * but sets `redisAvailable: false` so the UI can flag that the status
 * is nominal rather than measured.
 */
export async function getBreakerStatus(): Promise<BreakerStatus> {
  const redisAvailable = !!getRedis();
  const [xai, anthropic] = await Promise.all([
    getCircuitState("xai"),
    getCircuitState("anthropic"),
  ]);
  return { xai, anthropic, redisAvailable };
}
