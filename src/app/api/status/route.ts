import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sql = getDb();

    const [crons] = await sql`SELECT COUNT(*)::int as count FROM cron_runs`;
    const activeCronCount = 21; // Fixed; defined in vercel.json

    const lastRuns = await sql`
      SELECT cron_name, status, started_at, duration_ms
      FROM cron_runs
      ORDER BY started_at DESC
      LIMIT 10
    `;

    const [errors24h] = await sql`
      SELECT COUNT(*)::int as count
      FROM cron_runs
      WHERE status IN ('error', 'failed') AND started_at > NOW() - INTERVAL '24 hours'
    `;

    const [lastError] = await sql`
      SELECT cron_name, error, started_at
      FROM cron_runs
      WHERE status IN ('error', 'failed')
      ORDER BY started_at DESC
      LIMIT 1
    `;

    const uptime = process.uptime();
    const uptimeHours = Math.round((uptime / 3600) * 10) / 10;

    return NextResponse.json({
      status: errors24h[0]?.count > 0 ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      crons: {
        active: activeCronCount,
        total_runs: Number(crons[0]?.count ?? 0),
        errors_24h: Number(errors24h[0]?.count ?? 0),
        last_error: lastError
          ? {
              cron: lastError.cron_name,
              message: lastError.error,
              at: lastError.started_at,
            }
          : null,
      },
      recent_runs: lastRuns.map((r) => ({
        cron: r.cron_name,
        status: r.status,
        started_at: r.started_at,
        duration_ms: r.duration_ms,
      })),
      uptime_hours: uptimeHours,
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : "Health check failed",
      },
      { status: 500 }
    );
  }
}
