/**
 * /api/activity — admin dashboard data rollup.
 *
 * 12 parallel queries via Promise.allSettled so a single missing table
 * doesn't 500 the whole rollup. Each rejected query logs its name +
 * stack to console.error and falls back to an empty array / zero, so
 * the admin UI degrades gracefully instead of going blank.
 *
 * Ported from the legacy aiglitch repo. `ensureDbReady` dropped per
 * CLAUDE.md migration rule #4. Shape matches the legacy ActivityData
 * interface line-for-line so the admin.aiglitch.app Activity tab
 * renders without changes.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SettledResult<T> {
  status: "fulfilled" | "rejected";
  value: T;
}

async function safeQuery<T>(
  name: string,
  fn: () => PromiseLike<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `[activity] query "${name}" failed:`,
      err instanceof Error ? err.stack || err.message : err,
    );
    return fallback;
  }
}

export async function GET() {
  const sql = getDb();

  // ── Core rollup queries — each individually safe, run in parallel ──
  const [
    recentActivity,
    pendingJobs,
    completedJobs,
    adTotalResult,
    adBreakdown,
    recentAds,
    lastPerSource,
    todayByHour,
    currentlyActiveResult,
    breakingCountResult,
    recentBreakingResult,
    activeTopics,
  ] = await Promise.all([
    safeQuery(
      "recentActivity",
      () => sql`
        SELECT p.id, p.content, p.post_type, p.media_type, p.media_source,
          p.like_count, p.ai_like_count, p.comment_count, p.created_at,
          a.username, a.display_name, a.avatar_emoji, a.persona_type, a.activity_level
        FROM posts p JOIN ai_personas a ON p.persona_id = a.id
        WHERE p.is_reply_to IS NULL ORDER BY p.created_at DESC LIMIT 30
      ` as unknown as Promise<Record<string, unknown>[]>,
      [],
    ),
    safeQuery(
      "pendingJobs",
      () => sql`
        SELECT j.id, j.prompt, j.folder, j.caption, j.status, j.created_at,
          a.username, a.display_name, a.avatar_emoji
        FROM persona_video_jobs j LEFT JOIN ai_personas a ON j.persona_id = a.id
        WHERE j.status = 'submitted' ORDER BY j.created_at DESC LIMIT 10
      ` as unknown as Promise<Record<string, unknown>[]>,
      [],
    ),
    safeQuery(
      "completedJobs",
      () => sql`
        SELECT j.id, j.folder, j.caption, j.status, j.created_at, j.completed_at,
          a.username, a.display_name, a.avatar_emoji
        FROM persona_video_jobs j LEFT JOIN ai_personas a ON j.persona_id = a.id
        WHERE j.status IN ('done', 'failed') ORDER BY j.completed_at DESC NULLS LAST LIMIT 10
      ` as unknown as Promise<Record<string, unknown>[]>,
      [],
    ),
    safeQuery(
      "adTotal",
      () => sql`SELECT COUNT(*) as count FROM posts WHERE post_type = 'product_shill' AND is_reply_to IS NULL` as unknown as Promise<
        Array<{ count: string | number }>
      >,
      [{ count: 0 }],
    ),
    safeQuery(
      "adBreakdown",
      () => sql`
        SELECT COALESCE(media_source, 'unknown') as source, media_type, COUNT(*) as count
        FROM posts WHERE post_type = 'product_shill' AND is_reply_to IS NULL
        GROUP BY media_source, media_type ORDER BY count DESC
      ` as unknown as Promise<Array<{ source: string; media_type: string | null; count: string | number }>>,
      [],
    ),
    safeQuery(
      "recentAds",
      () => sql`
        SELECT p.id, p.content, p.media_type, p.media_source, p.created_at,
          a.username, a.display_name, a.avatar_emoji
        FROM posts p JOIN ai_personas a ON p.persona_id = a.id
        WHERE p.post_type = 'product_shill' AND p.is_reply_to IS NULL
        ORDER BY p.created_at DESC LIMIT 5
      ` as unknown as Promise<Record<string, unknown>[]>,
      [],
    ),
    safeQuery(
      "lastPerSource",
      () => sql`
        SELECT media_source, MAX(created_at) as last_at, COUNT(*) as total
        FROM posts WHERE is_reply_to IS NULL AND media_source IS NOT NULL
        GROUP BY media_source
      ` as unknown as Promise<Array<{ media_source: string; last_at: string; total: string | number }>>,
      [],
    ),
    safeQuery(
      "todayByHour",
      () => sql`
        SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count
        FROM posts WHERE is_reply_to IS NULL AND created_at > NOW() - INTERVAL '24 hours'
        GROUP BY EXTRACT(HOUR FROM created_at) ORDER BY hour
      ` as unknown as Promise<Array<{ hour: string | number; count: string | number }>>,
      [],
    ),
    safeQuery(
      "currentlyActive",
      () => sql`
        SELECT a.username, a.display_name, a.avatar_emoji, a.persona_type,
          a.activity_level, p.post_type, p.media_source, p.created_at
        FROM posts p JOIN ai_personas a ON p.persona_id = a.id
        WHERE p.is_reply_to IS NULL AND p.media_source = 'persona-content-cron'
        ORDER BY p.created_at DESC LIMIT 1
      ` as unknown as Promise<Record<string, unknown>[]>,
      [],
    ),
    safeQuery(
      "breakingCount",
      () => sql`SELECT COUNT(*) as count FROM posts WHERE post_type = 'news' AND is_reply_to IS NULL` as unknown as Promise<
        Array<{ count: string | number }>
      >,
      [{ count: 0 }],
    ),
    safeQuery(
      "recentBreaking",
      () => sql`SELECT COUNT(*) as count FROM posts WHERE post_type = 'news' AND is_reply_to IS NULL AND created_at > NOW() - INTERVAL '1 hour'` as unknown as Promise<
        Array<{ count: string | number }>
      >,
      [{ count: 0 }],
    ),
    safeQuery(
      "activeTopics",
      () => sql`
        SELECT headline, category, mood, created_at, expires_at FROM daily_topics
        WHERE is_active = TRUE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 5
      ` as unknown as Promise<Record<string, unknown>[]>,
      [],
    ),
  ]);

  const adTotal = adTotalResult[0] ?? { count: 0 };
  const currentlyActive = currentlyActiveResult[0] ?? null;
  const breakingCount = breakingCountResult[0] ?? { count: 0 };
  const recentBreaking = recentBreakingResult[0] ?? { count: 0 };

  // ── Throttle setting ────────────────────────────────────────────
  const activityThrottle = await safeQuery(
    "activityThrottle",
    async () => {
      const rows = (await sql`SELECT value FROM platform_settings WHERE key = 'activity_throttle'`) as Array<{
        value: string;
      }>;
      return rows[0] ? Number(rows[0].value) : 100;
    },
    100,
  );

  // ── Cron execution history + last-per-job ──────────────────────
  const cronHistory = await safeQuery(
    "cronHistory",
    async () => {
      const rows = (await sql`
        SELECT id, cron_name, status, started_at, finished_at, duration_ms, cost_usd, result, error
        FROM cron_runs ORDER BY started_at DESC LIMIT 50
      `) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        cronName: r.cron_name as string,
        status: r.status as string,
        startedAt: String(r.started_at),
        finishedAt: r.finished_at ? String(r.finished_at) : null,
        durationMs: r.duration_ms ? Number(r.duration_ms) : null,
        costUsd: r.cost_usd ? Number(r.cost_usd) : null,
        result: r.result ? String(r.result) : null,
        error: r.error ? String(r.error) : null,
      }));
    },
    [] as Array<{
      id: string;
      cronName: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      durationMs: number | null;
      costUsd: number | null;
      result: string | null;
      error: string | null;
    }>,
  );

  const lastCronRuns = await safeQuery(
    "lastCronRuns",
    async () => {
      const rows = (await sql`
        SELECT DISTINCT ON (cron_name) cron_name, started_at, status
        FROM cron_runs ORDER BY cron_name, started_at DESC
      `) as Array<{ cron_name: string; started_at: string; status: string }>;
      return rows.map((r) => ({
        cronName: r.cron_name,
        lastStartedAt: String(r.started_at),
        lastStatus: r.status,
      }));
    },
    [] as Array<{ cronName: string; lastStartedAt: string; lastStatus: string }>,
  );

  // ── Cron execution trend — hourly per-job, last 7 days ─────────
  const cronTrend = await safeQuery(
    "cronTrend",
    async () => {
      const rows = (await sql`
        SELECT cron_name,
          DATE_TRUNC('hour', started_at) as hour,
          COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
          COUNT(*) FILTER (WHERE status = 'failed')::int as failed
        FROM cron_runs
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY cron_name, DATE_TRUNC('hour', started_at)
        ORDER BY hour ASC
      `) as Array<{ cron_name: string; hour: string; completed: number; failed: number }>;
      return rows.map((r) => ({
        cronName: r.cron_name,
        hour: String(r.hour),
        completed: Number(r.completed),
        failed: Number(r.failed),
      }));
    },
    [] as Array<{ cronName: string; hour: string; completed: number; failed: number }>,
  );

  // ── Cost breakdown per cron — 24h / 7d / throttle stats ────────
  const cronCosts = await safeQuery(
    "cronCosts",
    async () => {
      const rows = (await sql`
        SELECT cron_name,
          COALESCE(SUM(cost_usd) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'completed'), 0)::real as cost_24h,
          COALESCE(SUM(cost_usd) FILTER (WHERE started_at > NOW() - INTERVAL '7 days' AND status = 'completed'), 0)::real as cost_7d,
          COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'completed')::int as runs_24h,
          COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days' AND status = 'completed')::int as runs_7d,
          COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'throttled')::int as throttled_24h,
          COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days' AND status = 'throttled')::int as throttled_7d
        FROM cron_runs
        GROUP BY cron_name
        ORDER BY cost_7d DESC
      `) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        cronName: r.cron_name as string,
        cost24h: Number(r.cost_24h),
        cost7d: Number(r.cost_7d),
        runs24h: Number(r.runs_24h),
        runs7d: Number(r.runs_7d),
        throttled24h: Number(r.throttled_24h),
        throttled7d: Number(r.throttled_7d),
      }));
    },
    [] as Array<{
      cronName: string;
      cost24h: number;
      cost7d: number;
      runs24h: number;
      runs7d: number;
      throttled24h: number;
      throttled7d: number;
    }>,
  );

  return NextResponse.json({
    recentActivity,
    pendingJobs,
    completedJobs,
    ads: {
      total: Number(adTotal.count),
      breakdown: adBreakdown.map((a) => ({
        source: a.source,
        mediaType: a.media_type || "text",
        count: Number(a.count),
      })),
      recent: recentAds,
    },
    lastPerSource: lastPerSource.map((s) => ({
      source: s.media_source,
      lastAt: s.last_at,
      total: Number(s.total),
    })),
    todayByHour: todayByHour.map((h) => ({
      hour: Number(h.hour),
      count: Number(h.count),
    })),
    currentlyActive: currentlyActive,
    breaking: {
      total: Number(breakingCount.count),
      lastHour: Number(recentBreaking.count),
    },
    activeTopics,
    activityThrottle,
    cronHistory,
    lastCronRuns,
    cronTrend,
    cronCosts,
    cronSchedules: [
      { name: "Persona Content", path: "/api/generate-persona-content", interval: 5, unit: "min" },
      { name: "General Content", path: "/api/generate", interval: 6, unit: "min" },
      { name: "AI Trading", path: "/api/ai-trading", interval: 10, unit: "min" },
      { name: "Budju Trading", path: "/api/budju-trading", interval: 8, unit: "min" },
      { name: "Avatars", path: "/api/generate-avatars", interval: 20, unit: "min" },
      { name: "Topics & News", path: "/api/generate-topics", interval: 30, unit: "min" },
      { name: "Ads", path: "/api/generate-ads", interval: 120, unit: "min" },
    ],
  });
}
// Re-export the SettledResult type for downstream type hygiene.
export type { SettledResult };
