/**
 * Per-endpoint aggregate metrics over `migration_request_log`.
 *
 * GET — admin-auth'd. Optional `?since=24h|7d|all` window
 * (default `24h`). Returns one row per `path` with:
 *   • method_set    — comma-joined list of methods seen
 *   • total         — total calls
 *   • ok            — 2xx count
 *   • errors        — 4xx+ or network-error (status IS NULL) count
 *   • error_rate    — 0-100 float, 1dp
 *   • p50_ms / p95_ms — `percentile_cont` over `duration_ms`
 *   • last_at       — most-recent call timestamp
 *
 * Rows sorted by total DESC. Use this for the Metrics tab.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { ensureRequestLogTable } from "@/lib/migration/request-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Window = "24h" | "7d" | "all";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("since");
  const window: Window = raw === "7d" || raw === "all" ? raw : "24h";

  await ensureRequestLogTable();
  const sql = getDb();

  // Branch by window — can't parametrise INTERVAL literals alongside tagged templates cleanly.
  let rows: unknown[];
  if (window === "24h") {
    rows = (await sql`
      SELECT
        path,
        STRING_AGG(DISTINCT method, ',' ORDER BY method) AS method_set,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status >= 200 AND status < 300)::int AS ok,
        COUNT(*) FILTER (WHERE status >= 400 OR status IS NULL)::int AS errors,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
        MAX(created_at) AS last_at
      FROM migration_request_log
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY path
      ORDER BY total DESC
    `) as unknown as unknown[];
  } else if (window === "7d") {
    rows = (await sql`
      SELECT
        path,
        STRING_AGG(DISTINCT method, ',' ORDER BY method) AS method_set,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status >= 200 AND status < 300)::int AS ok,
        COUNT(*) FILTER (WHERE status >= 400 OR status IS NULL)::int AS errors,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
        MAX(created_at) AS last_at
      FROM migration_request_log
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY path
      ORDER BY total DESC
    `) as unknown as unknown[];
  } else {
    rows = (await sql`
      SELECT
        path,
        STRING_AGG(DISTINCT method, ',' ORDER BY method) AS method_set,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status >= 200 AND status < 300)::int AS ok,
        COUNT(*) FILTER (WHERE status >= 400 OR status IS NULL)::int AS errors,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
        MAX(created_at) AS last_at
      FROM migration_request_log
      GROUP BY path
      ORDER BY total DESC
    `) as unknown as unknown[];
  }

  const metrics = (rows as {
    path: string;
    method_set: string;
    total: number;
    ok: number;
    errors: number;
    p50_ms: number | null;
    p95_ms: number | null;
    last_at: string;
  }[]).map((r) => ({
    path: r.path,
    methods: r.method_set.split(",").filter(Boolean),
    total: r.total,
    ok: r.ok,
    errors: r.errors,
    error_rate:
      r.total > 0 ? Math.round((r.errors / r.total) * 1000) / 10 : 0,
    p50_ms: r.p50_ms,
    p95_ms: r.p95_ms,
    last_at: r.last_at,
  }));

  const summary = {
    window,
    endpoint_count: metrics.length,
    total_calls: metrics.reduce((s, m) => s + m.total, 0),
    total_errors: metrics.reduce((s, m) => s + m.errors, 0),
  };

  return NextResponse.json({ summary, metrics });
}
