/**
 * Admin dashboard aggregator — `/api/activity`.
 *
 * Pure read-only GET that the admin UI polls to render the Activity
 * tab: recent posts, video jobs, ad stats, hourly counts, breaking
 * news, cron history, cron trend, cron cost breakdown, active daily
 * topics, and director-movie stats.
 *
 * Every optional block is wrapped in its own `try/catch` so missing
 * tables degrade gracefully — the admin UI still renders with zero
 * counts instead of a 500. Tables that are NOT in the new repo's
 * schema yet (`director_movies`, `multi_clip_scenes`,
 * `multi_clip_jobs`, `persona_video_jobs`) just report their default
 * empty shape.
 *
 * Route is intentionally UNAUTH'd — matches legacy parity. The admin
 * UI page itself is behind the admin-auth cookie; locking the JSON
 * endpoint would orphan the dashboard.
 *
 * Notes vs. legacy:
 *   • `cron_runs.status` is `'ok' | 'error' | 'running'` in the new
 *     repo (legacy wrote `'completed' | 'throttled' | 'failed'`).
 *     Stat queries are re-pointed accordingly. `throttled24h` /
 *     `throttled7d` will always be 0 until cron throttling is
 *     re-introduced (the new `cronHandler` has no throttle concept).
 *   • `ensureDbReady` / `safeMigrate` dropped — new repo assumes
 *     schema is already in place on shared Neon.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Sql = ReturnType<typeof getDb>;

export async function GET() {
  const sql = getDb();

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
    sql`SELECT p.id, p.content, p.post_type, p.media_type, p.media_source,
      p.like_count, p.ai_like_count, p.comment_count, p.created_at,
      a.username, a.display_name, a.avatar_emoji, a.persona_type, a.activity_level
      FROM posts p JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.is_reply_to IS NULL ORDER BY p.created_at DESC LIMIT 30`,
    safeQuery(
      sql,
      sql`SELECT j.id, j.prompt, j.folder, j.caption, j.status, j.created_at,
        a.username, a.display_name, a.avatar_emoji
        FROM persona_video_jobs j LEFT JOIN ai_personas a ON j.persona_id = a.id
        WHERE j.status = 'submitted' ORDER BY j.created_at DESC LIMIT 10`,
    ),
    safeQuery(
      sql,
      sql`SELECT j.id, j.folder, j.caption, j.status, j.created_at, j.completed_at,
        a.username, a.display_name, a.avatar_emoji
        FROM persona_video_jobs j LEFT JOIN ai_personas a ON j.persona_id = a.id
        WHERE j.status IN ('done', 'failed') ORDER BY j.completed_at DESC NULLS LAST LIMIT 10`,
    ),
    sql`SELECT COUNT(*) as count FROM posts WHERE post_type = 'product_shill' AND is_reply_to IS NULL`,
    sql`SELECT COALESCE(media_source, 'unknown') as source, media_type, COUNT(*) as count
      FROM posts WHERE post_type = 'product_shill' AND is_reply_to IS NULL
      GROUP BY media_source, media_type ORDER BY count DESC`,
    sql`SELECT p.id, p.content, p.media_type, p.media_source, p.created_at,
      a.username, a.display_name, a.avatar_emoji
      FROM posts p JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.post_type = 'product_shill' AND p.is_reply_to IS NULL
      ORDER BY p.created_at DESC LIMIT 5`,
    sql`SELECT media_source, MAX(created_at) as last_at, COUNT(*) as total
      FROM posts WHERE is_reply_to IS NULL AND media_source IS NOT NULL GROUP BY media_source`,
    sql`SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count
      FROM posts WHERE is_reply_to IS NULL AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY EXTRACT(HOUR FROM created_at) ORDER BY hour`,
    sql`SELECT a.username, a.display_name, a.avatar_emoji, a.persona_type,
      a.activity_level, p.post_type, p.media_source, p.created_at
      FROM posts p JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.is_reply_to IS NULL AND p.media_source = 'persona-content-cron'
      ORDER BY p.created_at DESC LIMIT 1`,
    sql`SELECT COUNT(*) as count FROM posts WHERE post_type = 'news' AND is_reply_to IS NULL`,
    sql`SELECT COUNT(*) as count FROM posts WHERE post_type = 'news' AND is_reply_to IS NULL AND created_at > NOW() - INTERVAL '1 hour'`,
    safeQuery(
      sql,
      sql`SELECT headline, category, mood, created_at, expires_at FROM daily_topics
        WHERE is_active = TRUE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 5`,
    ),
  ]);

  const adTotal = (adTotalResult as { count: number }[])[0] ?? { count: 0 };
  const currentlyActive = (currentlyActiveResult as Record<string, unknown>[])[0] ?? null;
  const breakingCount = (breakingCountResult as { count: number }[])[0] ?? { count: 0 };
  const recentBreaking = (recentBreakingResult as { count: number }[])[0] ?? { count: 0 };

  const directorStats = await fetchDirectorStats(sql);
  const recentMovies = await fetchRecentMovies(sql);
  const activityThrottle = await fetchActivityThrottle(sql);
  const { cronHistory, lastCronRuns } = await fetchCronHistory(sql);
  const cronTrend = await fetchCronTrend(sql);
  const cronCosts = await fetchCronCosts(sql);

  const lastPerSourceArr = (
    lastPerSource as { media_source: string; last_at: string; total: number }[]
  ).map((s) => ({
    source: s.media_source,
    lastAt: s.last_at,
    total: Number(s.total),
  }));
  if (
    directorStats.lastAt &&
    !lastPerSourceArr.find((s) => s.source === "director-movie")
  ) {
    lastPerSourceArr.push({
      source: "director-movie",
      lastAt: directorStats.lastAt,
      total: directorStats.total,
    });
  }

  return NextResponse.json({
    recentActivity,
    pendingJobs,
    completedJobs,
    ads: {
      total: Number(adTotal.count),
      breakdown: (
        adBreakdown as { source: string; media_type: string | null; count: number }[]
      ).map((a) => ({
        source: a.source,
        mediaType: a.media_type ?? "text",
        count: Number(a.count),
      })),
      recent: recentAds,
    },
    lastPerSource: lastPerSourceArr,
    todayByHour: (todayByHour as { hour: number; count: number }[]).map((h) => ({
      hour: Number(h.hour),
      count: Number(h.count),
    })),
    currentlyActive,
    breaking: {
      total: Number(breakingCount.count),
      lastHour: Number(recentBreaking.count),
    },
    activeTopics,
    activityThrottle,
    directorStats,
    recentMovies,
    cronHistory,
    lastCronRuns,
    cronTrend,
    cronCosts,
    cronSchedules: [
      { name: "Persona Content", path: "/api/generate-persona-content", interval: 5, unit: "min" },
      { name: "General Content", path: "/api/generate", interval: 6, unit: "min" },
      { name: "Director Movies", path: "/api/generate-director-movie", interval: 10, unit: "min" },
      { name: "AI Trading", path: "/api/ai-trading", interval: 10, unit: "min" },
      { name: "Budju Trading", path: "/api/budju-trading", interval: 8, unit: "min" },
      { name: "Avatars", path: "/api/generate-avatars", interval: 20, unit: "min" },
      { name: "Topics & News", path: "/api/generate-topics", interval: 30, unit: "min" },
      { name: "Ads", path: "/api/generate-ads", interval: 120, unit: "min" },
    ],
  });
}

async function safeQuery<T>(_sql: Sql, promise: Promise<T>): Promise<T | unknown[]> {
  try {
    return await promise;
  } catch {
    return [];
  }
}

async function fetchDirectorStats(
  sql: Sql,
): Promise<{ total: number; generating: number; lastAt: string | null }> {
  try {
    const [totalRows, generatingRows, lastRows] = await Promise.all([
      sql`SELECT COUNT(*)::int as count FROM director_movies WHERE COALESCE(source, 'cron') = 'cron'`,
      sql`SELECT COUNT(*)::int as count FROM director_movies WHERE status IN ('pending', 'generating') AND COALESCE(source, 'cron') = 'cron'`,
      sql`SELECT created_at FROM director_movies WHERE COALESCE(source, 'cron') = 'cron' ORDER BY created_at DESC LIMIT 1`,
    ]);
    return {
      total: Number((totalRows as { count: number }[])[0]?.count ?? 0),
      generating: Number((generatingRows as { count: number }[])[0]?.count ?? 0),
      lastAt: (lastRows as { created_at: string }[])[0]?.created_at
        ? String((lastRows as { created_at: string }[])[0]!.created_at)
        : null,
    };
  } catch {
    return { total: 0, generating: 0, lastAt: null };
  }
}

type MovieRow = {
  id: string;
  title: string;
  genre: string;
  director_username: string;
  director_display_name: string | null;
  status: string;
  clip_count: number;
  created_at: string;
  video_url: string | null;
  premiere_post_id: string | null;
};

type ClipDiagRow = {
  movie_id: string;
  scene_number: number;
  status: string;
  fail_reason: string | null;
  elapsed_secs: number;
};

type Movie = {
  id: string;
  title: string;
  genre: string;
  director_username: string;
  director_display_name: string;
  status: string;
  clip_count: number;
  created_at: string;
  video_url: string | null;
  premiere_post_id: string | null;
  clipDiagnostics?: {
    scene: number;
    status: string;
    failReason: string | null;
    elapsedMin: number;
  }[];
};

async function fetchRecentMovies(sql: Sql): Promise<Movie[]> {
  try {
    const rows = (await sql`
      SELECT dm.id, dm.title, dm.genre, dm.director_username, dm.status, dm.clip_count,
        dm.created_at, dm.premiere_post_id, a.display_name as director_display_name, p.media_url as video_url
      FROM director_movies dm
      LEFT JOIN ai_personas a ON a.id = dm.director_id
      LEFT JOIN posts p ON p.id = dm.premiere_post_id
      WHERE COALESCE(dm.source, 'cron') = 'cron'
      ORDER BY dm.created_at DESC LIMIT 20
    `) as unknown as MovieRow[];

    const movies: Movie[] = rows.map((m) => ({
      id: String(m.id),
      title: String(m.title),
      genre: String(m.genre),
      director_username: String(m.director_username),
      director_display_name: String(m.director_display_name ?? m.director_username),
      status: String(m.status),
      clip_count: Number(m.clip_count),
      created_at: String(m.created_at),
      video_url: m.video_url ? String(m.video_url) : null,
      premiere_post_id: m.premiere_post_id ? String(m.premiere_post_id) : null,
    }));

    const failedOrActive = movies.filter(
      (m) => m.status === "failed" || m.status === "generating",
    );
    if (failedOrActive.length > 0) {
      try {
        const ids = failedOrActive.map((m) => m.id);
        const diag = (await sql`
          SELECT dm.id as movie_id, s.scene_number, s.status, s.fail_reason,
            EXTRACT(EPOCH FROM (COALESCE(s.completed_at, NOW()) - s.created_at))::int as elapsed_secs
          FROM multi_clip_scenes s
          JOIN multi_clip_jobs j ON s.job_id = j.id
          JOIN director_movies dm ON dm.multi_clip_job_id = j.id
          WHERE dm.id = ANY(${ids})
          ORDER BY dm.id, s.scene_number
        `) as unknown as ClipDiagRow[];

        for (const movie of movies) {
          const scenes = diag.filter((c) => c.movie_id === movie.id);
          if (scenes.length > 0) {
            movie.clipDiagnostics = scenes.map((s) => ({
              scene: s.scene_number,
              status: s.status,
              failReason: s.fail_reason,
              elapsedMin: Math.round(s.elapsed_secs / 60),
            }));
          }
        }
      } catch {
        // multi_clip_scenes / fail_reason column may not exist yet
      }
    }
    return movies;
  } catch {
    return [];
  }
}

async function fetchActivityThrottle(sql: Sql): Promise<number> {
  try {
    const rows = (await sql`
      SELECT value FROM platform_settings WHERE key = 'activity_throttle'
    `) as unknown as { value: string }[];
    return rows[0] ? Number(rows[0].value) : 100;
  } catch {
    return 100;
  }
}

type CronHistoryRow = {
  id: string;
  cronName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  result: string | null;
  error: string | null;
};

async function fetchCronHistory(sql: Sql): Promise<{
  cronHistory: CronHistoryRow[];
  lastCronRuns: { cronName: string; lastStartedAt: string; lastStatus: string }[];
}> {
  try {
    const [historyRaw, lastRunsRaw] = await Promise.all([
      sql`SELECT id, cron_name, status, started_at, finished_at, duration_ms, cost_usd, result, error
        FROM cron_runs ORDER BY started_at DESC LIMIT 50`,
      sql`SELECT DISTINCT ON (cron_name) cron_name, started_at, status
        FROM cron_runs ORDER BY cron_name, started_at DESC`,
    ]);

    const cronHistory = (historyRaw as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      cronName: String(r.cron_name),
      status: String(r.status),
      startedAt: String(r.started_at),
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
      costUsd: r.cost_usd != null ? Number(r.cost_usd) : null,
      result: r.result ? String(r.result) : null,
      error: r.error ? String(r.error) : null,
    }));

    const lastCronRuns = (lastRunsRaw as Record<string, unknown>[]).map((r) => ({
      cronName: String(r.cron_name),
      lastStartedAt: String(r.started_at),
      lastStatus: String(r.status),
    }));

    return { cronHistory, lastCronRuns };
  } catch {
    return { cronHistory: [], lastCronRuns: [] };
  }
}

async function fetchCronTrend(
  sql: Sql,
): Promise<{ cronName: string; hour: string; completed: number; failed: number }[]> {
  try {
    const rows = (await sql`
      SELECT cron_name,
        DATE_TRUNC('hour', started_at) as hour,
        COUNT(*) FILTER (WHERE status = 'ok')::int as completed,
        COUNT(*) FILTER (WHERE status = 'error')::int as failed
      FROM cron_runs
      WHERE started_at > NOW() - INTERVAL '7 days'
      GROUP BY cron_name, DATE_TRUNC('hour', started_at)
      ORDER BY hour ASC
    `) as unknown as Record<string, unknown>[];

    return rows.map((r) => ({
      cronName: String(r.cron_name),
      hour: String(r.hour),
      completed: Number(r.completed),
      failed: Number(r.failed),
    }));
  } catch {
    return [];
  }
}

async function fetchCronCosts(sql: Sql): Promise<
  {
    cronName: string;
    cost24h: number;
    cost7d: number;
    runs24h: number;
    runs7d: number;
    throttled24h: number;
    throttled7d: number;
  }[]
> {
  try {
    const rows = (await sql`
      SELECT cron_name,
        COALESCE(SUM(cost_usd) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'ok'), 0)::real as cost_24h,
        COALESCE(SUM(cost_usd) FILTER (WHERE started_at > NOW() - INTERVAL '7 days' AND status = 'ok'), 0)::real as cost_7d,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'ok')::int as runs_24h,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days' AND status = 'ok')::int as runs_7d,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'throttled')::int as throttled_24h,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days' AND status = 'throttled')::int as throttled_7d
      FROM cron_runs
      GROUP BY cron_name
      ORDER BY cost_7d DESC
    `) as unknown as Record<string, unknown>[];

    return rows.map((r) => ({
      cronName: String(r.cron_name),
      cost24h: Number(r.cost_24h),
      cost7d: Number(r.cost_7d),
      runs24h: Number(r.runs_24h),
      runs7d: Number(r.runs_7d),
      throttled24h: Number(r.throttled_24h),
      throttled7d: Number(r.throttled_7d),
    }));
  } catch {
    return [];
  }
}
