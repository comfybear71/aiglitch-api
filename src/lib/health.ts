import { neon } from "@neondatabase/serverless";
import { Redis } from "@upstash/redis";

export type CheckResult = {
  ok: boolean;
  latency_ms: number;
  optional: boolean;
  error?: string;
  skipped?: boolean;
};

export type HealthReport = {
  status: "ok" | "degraded" | "down";
  checks: Record<string, CheckResult>;
  version: string;
  timestamp: string;
};

export type HealthChecks = {
  database: () => Promise<CheckResult>;
  redis: () => Promise<CheckResult>;
  xai: () => Promise<CheckResult>;
  anthropic: () => Promise<CheckResult>;
};

const REACHABILITY_TIMEOUT_MS = 2000;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = Date.now();
  const result = await fn();
  return { ms: Date.now() - start, result };
}

export async function checkDatabase(): Promise<CheckResult> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return { ok: false, latency_ms: 0, optional: false, error: "DATABASE_URL not set" };
  }
  try {
    const sql = neon(url);
    const { ms } = await timed(async () => sql`SELECT 1`);
    return { ok: true, latency_ms: ms, optional: false };
  } catch (err) {
    return {
      ok: false,
      latency_ms: 0,
      optional: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkRedis(): Promise<CheckResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { ok: true, latency_ms: 0, optional: true, skipped: true };
  }
  try {
    const redis = new Redis({ url, token });
    const { ms, result } = await timed(async () => redis.ping());
    return {
      ok: result === "PONG",
      latency_ms: ms,
      optional: true,
      error: result === "PONG" ? undefined : `unexpected reply: ${String(result)}`,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: 0,
      optional: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkReachable(url: string, optional: boolean): Promise<CheckResult> {
  try {
    const { ms } = await timed(async () =>
      fetch(url, { method: "GET", signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) })
    );
    return { ok: true, latency_ms: ms, optional };
  } catch (err) {
    return {
      ok: false,
      latency_ms: 0,
      optional,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkXai(): Promise<CheckResult> {
  if (!process.env.XAI_API_KEY) {
    return { ok: true, latency_ms: 0, optional: true, skipped: true };
  }
  return checkReachable("https://api.x.ai/v1", true);
}

export async function checkAnthropic(): Promise<CheckResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: true, latency_ms: 0, optional: true, skipped: true };
  }
  return checkReachable("https://api.anthropic.com/v1", true);
}

export const defaultChecks: HealthChecks = {
  database: checkDatabase,
  redis: checkRedis,
  xai: checkXai,
  anthropic: checkAnthropic,
};

export function computeStatus(
  checks: Record<string, CheckResult>
): "ok" | "degraded" | "down" {
  const entries = Object.values(checks);
  const requiredFailed = entries.some((c) => !c.optional && !c.ok);
  if (requiredFailed) return "down";
  const optionalFailed = entries.some((c) => c.optional && !c.ok);
  return optionalFailed ? "degraded" : "ok";
}

export async function runHealth(
  checks: HealthChecks = defaultChecks,
  version = "0.2.0"
): Promise<HealthReport> {
  const [database, redis, xai, anthropic] = await Promise.all([
    checks.database(),
    checks.redis(),
    checks.xai(),
    checks.anthropic(),
  ]);
  const results = { database, redis, xai, anthropic };
  return {
    status: computeStatus(results),
    checks: results,
    version,
    timestamp: new Date().toISOString(),
  };
}
