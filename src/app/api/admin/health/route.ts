/**
 * GET /api/admin/health
 *
 * Pings the five external services this backend depends on and reports
 * latency + status per service. All probes run in parallel with a 5s
 * timeout each. Overall status is "ok" only when every probe succeeds
 * — one degraded service flips the top-level flag without failing the
 * request.
 *
 * Services checked:
 *   - database (Neon Postgres via SELECT 1)
 *   - redis    (Upstash REST /ping)
 *   - solana   (Helius if keyed, else mainnet-beta)
 *   - anthropic (/v1/models probe)
 *   - xai       (/v1/models probe)
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { getUpstashCredentials } from "@/lib/upstash-env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROBE_TIMEOUT_MS = 5_000;
const REDIS_TIMEOUT_MS = 3_000;

interface ServiceCheck {
  status: "ok" | "error";
  latency_ms: number;
  message: string;
}

async function pingService(
  fn: () => Promise<void>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs),
      ),
    ]);
    return { status: "ok", latency_ms: Date.now() - start, message: "Connected" };
  } catch (err) {
    return {
      status: "error",
      latency_ms: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function settled<T>(
  r: PromiseSettledResult<T>,
  fallback: T,
): T {
  return r.status === "fulfilled" ? r.value : fallback;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [db, redis, solana, anthropic, xai] = await Promise.allSettled([
    pingService(async () => {
      const sql = getDb();
      await sql`SELECT 1 AS ping`;
    }),

    pingService(async () => {
      const creds = getUpstashCredentials();
      if (!creds) throw new Error("Not configured");
      const res = await fetch(`${creds.url}/ping`, {
        headers: { Authorization: `Bearer ${creds.token}` },
        signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }, REDIS_TIMEOUT_MS + 500),

    pingService(async () => {
      const heliusKey = process.env.HELIUS_API_KEY;
      const rpcUrl = heliusKey
        ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
        : "https://api.mainnet-beta.solana.com";
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const data = (await res.json()) as { result?: string; error?: { message?: string } };
      if (data.result !== "ok") throw new Error(data.error?.message || "Unhealthy");
    }),

    pingService(async () => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("Not configured");
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }),

    pingService(async () => {
      const key = process.env.XAI_API_KEY;
      if (!key) throw new Error("Not configured");
      const res = await fetch("https://api.x.ai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }),
  ]);

  const fallback: ServiceCheck = { status: "error", latency_ms: 0, message: "Check failed" };
  const services: Record<string, ServiceCheck> = {
    database:  settled(db,        fallback),
    redis:     settled(redis,     fallback),
    solana:    settled(solana,    fallback),
    anthropic: settled(anthropic, fallback),
    xai:       settled(xai,       fallback),
  };

  const allOk = Object.values(services).every((s) => s.status === "ok");

  return NextResponse.json({
    status: allOk ? "ok" : "degraded",
    checked_at: new Date().toISOString(),
    services,
  });
}
