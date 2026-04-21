/**
 * GET /api/admin/stats
 *
 * Platform-wide dashboard payload: content volume, persona activity,
 * engagement, media breakdown, special-content counters, recent posts,
 * AI-spend rollup, circuit-breaker state, community events, swaps, and
 * active-user counts — all in one call so the mobile admin app and the
 * web dashboard can render from a single request.
 *
 * Response has BOTH a flat block (mobile app keys) and a nested block
 * (web dashboard). Kept identical to legacy where possible; divergences:
 *   - `aiCosts.current` uses our DB-backed rollup (last 24h) instead of
 *     legacy's in-memory ledger (we don't have one)
 *   - `aiCosts.personaBreakdown` is []; our ai_cost_log doesn't carry
 *     persona_id. Schema will add it later; route handles that.
 *   - `circuitBreaker` reports our per-provider state, not RPM.
 *
 * Optional tables (`ai_beef_threads`, `ai_challenges`, `human_bookmarks`,
 * `community_events`, `otc_swaps`, `messages`) are each individually
 * try/catch'd so a missing table returns a zero instead of 500-ing the
 * whole dashboard.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  getLifetimeTotals,
  getCostHistory,
  getDailySpendTotals,
} from "@/lib/ai/cost-ledger";
import { getBreakerStatus } from "@/lib/ai/circuit-breaker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function safeCount(fn: () => Promise<{ count: string | number }[]>): Promise<number> {
  try {
    const rows = await fn();
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

async function safeRows<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  const [
    totalPosts,
    totalComments,
    totalPersonas,
    activePersonas,
    totalHumanLikes,
    totalAILikes,
    totalSubscriptions,
    totalUsers,
  ] = await Promise.all([
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM posts WHERE is_reply_to IS NULL` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM posts WHERE is_reply_to IS NOT NULL` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM ai_personas` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM ai_personas WHERE is_active = TRUE` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_likes` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM ai_interactions WHERE interaction_type = 'like'` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_subscriptions` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(DISTINCT session_id)::int AS count FROM human_likes` as unknown as Promise<{ count: number }[]>),
  ]);

  const postsPerDay = await safeRows(() => sql`
    SELECT DATE(created_at) AS date, COUNT(*)::int AS count
    FROM posts WHERE is_reply_to IS NULL
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 7
  ` as unknown as Promise<{ date: string; count: number }[]>);

  const topPersonas = await safeRows(() => sql`
    SELECT a.username, a.display_name, a.avatar_emoji, a.follower_count, a.post_count,
      COALESCE(SUM(p.like_count + p.ai_like_count), 0)::int AS total_engagement
    FROM ai_personas a
    LEFT JOIN posts p ON a.id = p.persona_id AND p.is_reply_to IS NULL
    GROUP BY a.id, a.username, a.display_name, a.avatar_emoji, a.follower_count, a.post_count
    ORDER BY total_engagement DESC
    LIMIT 10
  ` as unknown as Promise<unknown[]>);

  const postTypes = await safeRows(() => sql`
    SELECT post_type, COUNT(*)::int AS count
    FROM posts WHERE is_reply_to IS NULL
    GROUP BY post_type
    ORDER BY count DESC
  ` as unknown as Promise<{ post_type: string; count: number }[]>);

  const [videoCount, imageCount, memeCount, textCount] = await Promise.all([
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM posts WHERE is_reply_to IS NULL AND media_type = 'video'` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM posts WHERE is_reply_to IS NULL AND media_type = 'image' AND post_type = 'image'` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM posts WHERE is_reply_to IS NULL AND (post_type = 'meme' OR post_type = 'meme_description')` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM posts WHERE is_reply_to IS NULL AND media_type IS NULL` as unknown as Promise<{ count: number }[]>),
  ]);

  const [beefCount, challengeCount, bookmarkCount] = await Promise.all([
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM ai_beef_threads` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM ai_challenges` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM human_bookmarks` as unknown as Promise<{ count: number }[]>),
  ]);

  const sourceCounts = await safeRows(() => sql`
    SELECT
      COALESCE(media_source, 'text-only') AS source,
      COUNT(*)::int                       AS count,
      COUNT(*) FILTER (WHERE media_type = 'video')::int AS videos,
      COUNT(*) FILTER (WHERE media_type = 'image' AND post_type = 'image')::int AS images,
      COUNT(*) FILTER (WHERE post_type IN ('meme', 'meme_description'))::int   AS memes
    FROM posts WHERE is_reply_to IS NULL
    GROUP BY COALESCE(media_source, 'text-only')
    ORDER BY count DESC
  ` as unknown as Promise<{ source: string; count: number; videos: number; images: number; memes: number }[]>);

  const recentPosts = await safeRows(() => sql`
    SELECT p.id, p.content, p.post_type, p.like_count, p.ai_like_count, p.created_at,
      p.media_url, p.media_type, p.media_source, p.beef_thread_id, p.challenge_tag, p.is_collab_with,
      a.username, a.display_name, a.avatar_emoji
    FROM posts p
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE p.is_reply_to IS NULL
    ORDER BY p.created_at DESC
    LIMIT 20
  ` as unknown as Promise<unknown[]>);

  const [lifetime, costHistory, dailySpend, circuitBreaker] = await Promise.all([
    getLifetimeTotals(),
    getCostHistory(7),
    getDailySpendTotals(7),
    getBreakerStatus(),
  ]);

  const [activeEvents, completedEvents, totalEventVotes] = await Promise.all([
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM community_events WHERE status = 'active'` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM community_events WHERE status = 'completed'` as unknown as Promise<{ count: number }[]>),
    safeCount(() => sql`SELECT COUNT(*)::int AS count FROM community_event_votes` as unknown as Promise<{ count: number }[]>),
  ]);

  const [swapStats] = await safeRows(() => sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed')::int                  AS total_swaps,
      COALESCE(SUM(sol_cost) FILTER (WHERE status = 'completed'), 0)     AS total_sol,
      COALESCE(SUM(glitch_amount) FILTER (WHERE status = 'completed'), 0) AS total_glitch
    FROM otc_swaps
  ` as unknown as Promise<{ total_swaps: number; total_sol: string | number; total_glitch: string | number }[]>) as unknown as [
    { total_swaps: number; total_sol: string | number; total_glitch: string | number } | undefined,
  ];

  const active24h = await safeCount(() => sql`
    SELECT COUNT(DISTINCT session_id)::int AS count FROM human_likes
    WHERE created_at > NOW() - INTERVAL '24 hours'
  ` as unknown as Promise<{ count: number }[]>);

  const totalMessages = await safeCount(() => sql`SELECT COUNT(*)::int AS count FROM messages` as unknown as Promise<{ count: number }[]>);

  return NextResponse.json({
    // Flat keys for mobile dashboard compatibility
    total_users:         totalUsers,
    total_personas:      totalPersonas,
    total_messages:      totalMessages,
    total_conversations: 0,
    active_users_24h:    active24h,
    total_sol_received:  Number(Number(swapStats?.total_sol ?? 0).toFixed(6)),
    total_glitch_sold:   Number(Number(swapStats?.total_glitch ?? 0).toFixed(0)),
    total_swaps:         Number(swapStats?.total_swaps ?? 0),
    server_status:       "ok",

    // Nested data for web dashboard
    overview: {
      totalPosts,
      totalComments,
      totalPersonas,
      activePersonas,
      totalHumanLikes,
      totalAILikes,
      totalSubscriptions,
      totalUsers,
    },
    mediaBreakdown: {
      videos:      videoCount,
      images:      imageCount,
      memes:       memeCount,
      textOnly:    textCount,
      audioVideos: videoCount, // Veo 3 videos include audio
    },
    specialContent: {
      beefThreads: beefCount,
      challenges:  challengeCount,
      bookmarks:   bookmarkCount,
    },
    postsPerDay,
    topPersonas,
    postTypes,
    recentPosts,
    sourceCounts,
    aiCosts: {
      lifetime: {
        total_usd:   lifetime.totalUsd,
        total_calls: lifetime.totalCalls,
      },
      history:          costHistory,
      personaBreakdown: [], // ai_cost_log has no persona_id column in this schema
      dailySpend,
      circuitBreaker,
    },
    communityEvents: {
      activeEvents,
      completedEvents,
      totalVotes: totalEventVotes,
    },
  });
}
