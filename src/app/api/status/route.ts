import { NextResponse } from "next/server";
import { getCronHealth } from "@/lib/cron-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await getCronHealth();
    const uptimeHours = Math.round((process.uptime() / 3600) * 10) / 10;

    return NextResponse.json({
      status:
        health.errors_24h > 0 ||
        health.marketing.failed_24h > 0 ||
        health.marketing.silent_media_failures_24h > 0
          ? "degraded"
          : "ok",
      timestamp: new Date().toISOString(),
      crons: {
        active: health.active_count,
        total_runs: health.total_runs,
        errors_24h: health.errors_24h,
        last_error: health.recent_errors[0]
          ? {
              cron: health.recent_errors[0].cron_name,
              message: health.recent_errors[0].error,
              at: health.recent_errors[0].started_at,
            }
          : null,
      },
      marketing: health.marketing,
      recent_runs: health.recent_runs.map((r) => ({
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
