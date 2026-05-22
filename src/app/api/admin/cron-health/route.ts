import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdminAuth } from "@/lib/admin-auth";

export const maxDuration = 60;

const CRON_ROUTES = [
  "/api/cron/generate",
  "/api/cron/generate-topics",
  "/api/cron/generate-persona-content",
  "/api/cron/generate-ads",
  "/api/cron/generate-chaos-drop",
  "/api/cron/ai-trading",
  "/api/cron/budju-trading",
  "/api/cron/generate-avatars",
  "/api/cron/generate-director-movie",
  "/api/cron/persona-comments",
  "/api/cron/marketing-post",
  "/api/cron/marketing-metrics",
  "/api/cron/feedback-loop",
  "/api/cron/telegram/credit-check",
  "/api/cron/telegram/status",
  "/api/cron/telegram/persona-message",
  "/api/cron/x-react",
  "/api/cron/bestie-life",
  "/api/cron/admin/elon-campaign",
  "/api/cron/admin/budju-trading",
  "/api/cron/sponsor-burn",
  "/api/cron/x-dm-poll",
];

interface CronStatus {
  route: string;
  schedule: string;
  lastRun?: {
    status: string;
    finished_at: string;
    duration_ms: number;
    error?: string;
  };
  last7Days: {
    total: number;
    ok: number;
    error: number;
    errorRate: number;
  };
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminAuth(req);

    const sql = getDb();

    // Get schedules from vercel.json
    const schedules: Record<string, string> = {};
    const CRON_SCHEDULES = [
      { path: "/api/cron/generate", schedule: "*/30 * * * *" },
      { path: "/api/cron/generate-topics", schedule: "0 */2 * * *" },
      { path: "/api/cron/generate-persona-content", schedule: "*/40 * * * *" },
      { path: "/api/cron/generate-ads", schedule: "0 */4 * * *" },
      { path: "/api/cron/generate-chaos-drop", schedule: "0 */2 * * *" },
      { path: "/api/cron/ai-trading", schedule: "*/30 * * * *" },
      { path: "/api/cron/budju-trading", schedule: "*/30 * * * *" },
      { path: "/api/cron/generate-avatars", schedule: "0 */2 * * *" },
      { path: "/api/cron/generate-director-movie", schedule: "0 */2 * * *" },
      { path: "/api/cron/persona-comments", schedule: "0 */2 * * *" },
      { path: "/api/cron/marketing-post", schedule: "0 */4 * * *" },
      { path: "/api/cron/marketing-metrics", schedule: "0 * * * *" },
      { path: "/api/cron/feedback-loop", schedule: "0 */6 * * *" },
      { path: "/api/cron/telegram/credit-check", schedule: "*/30 * * * *" },
      { path: "/api/cron/telegram/status", schedule: "0 */6 * * *" },
      { path: "/api/cron/telegram/persona-message", schedule: "0 */3 * * *" },
      { path: "/api/cron/x-react", schedule: "*/30 * * * *" },
      { path: "/api/cron/bestie-life", schedule: "0 8,20 * * *" },
      { path: "/api/cron/admin/elon-campaign", schedule: "0 12 * * *" },
      { path: "/api/cron/admin/budju-trading", schedule: "*/10 * * * *" },
      { path: "/api/cron/sponsor-burn", schedule: "0 0 * * *" },
      { path: "/api/cron/x-dm-poll", schedule: "0 * * * *" },
    ];

    for (const { path, schedule } of CRON_SCHEDULES) {
      schedules[path] = schedule;
    }

    // Build cron status for each route
    const cronStatuses: CronStatus[] = await Promise.all(
      CRON_ROUTES.map(async (route) => {
        const cronName = route.replace("/api/cron/", "");

        // Get last run
        const lastRuns = await sql`
          SELECT status, finished_at, duration_ms, error
          FROM cron_runs
          WHERE cron_name = ${cronName}
          ORDER BY started_at DESC
          LIMIT 1
        `;

        // Get 7-day stats
        const stats = await sql`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
          FROM cron_runs
          WHERE cron_name = ${cronName}
          AND started_at > NOW() - INTERVAL '7 days'
        `;

        const stat = stats[0];
        const total = Number(stat.total) || 0;
        const ok = Number(stat.ok) || 0;
        const errors = Number(stat.error) || 0;

        return {
          route,
          schedule: schedules[route] || "unknown",
          lastRun: lastRuns[0]
            ? {
                status: lastRuns[0].status,
                finished_at: lastRuns[0].finished_at?.toISOString() || "",
                duration_ms: lastRuns[0].duration_ms || 0,
                error: lastRuns[0].error || undefined,
              }
            : undefined,
          last7Days: {
            total,
            ok,
            error: errors,
            errorRate: total > 0 ? Number(((errors / total) * 100).toFixed(1)) : 0,
          },
        };
      }),
    );

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      totalCrons: CRON_ROUTES.length,
      crons: cronStatuses,
      summary: {
        healthy: cronStatuses.filter((c) => c.lastRun?.status === "ok").length,
        failed: cronStatuses.filter((c) => c.lastRun?.status === "error").length,
        neverRun: cronStatuses.filter((c) => !c.lastRun).length,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 401 });
  }
}
