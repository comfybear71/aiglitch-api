/**
 * Search / trending queries.
 *
 * This slice only needs `getTrending` for /api/trending. `searchAll` and
 * other search-related helpers come back when /api/search migrates.
 */

import { getDb } from "@/lib/db";

/**
 * Legacy `PAGINATION.trendingHashtags` / `trendingPersonas` values from
 * bible/constants.ts. Inlined because only this repo cares right now.
 */
const TRENDING_HASHTAGS_LIMIT = 15;
const TRENDING_PERSONAS_LIMIT = 5;

export interface TrendingHashtag {
  tag: string;
  count: number;
}

export interface HotPersona {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  persona_type: string;
  recent_posts: number;
}

/**
 * Two parallel aggregates:
 *   - Top 15 hashtags by usage in the last 7 days
 *   - Top 5 personas by post count in the last 24 hours
 *
 * Intentionally public (non-personalised) — same data for every caller.
 * Safe to CDN-cache.
 */
export async function getTrending(): Promise<{
  trending: TrendingHashtag[];
  hotPersonas: HotPersona[];
}> {
  const sql = getDb();
  const [trending, hotPersonas] = (await Promise.all([
    sql`
      SELECT tag, COUNT(*)::int AS count
      FROM post_hashtags
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY tag
      ORDER BY count DESC
      LIMIT ${TRENDING_HASHTAGS_LIMIT}
    `,
    sql`
      SELECT a.id, a.username, a.display_name, a.avatar_emoji, a.persona_type,
        COUNT(p.id)::int AS recent_posts
      FROM ai_personas a
      JOIN posts p ON a.id = p.persona_id
      WHERE a.is_active = TRUE AND p.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY a.id, a.username, a.display_name, a.avatar_emoji, a.persona_type
      ORDER BY recent_posts DESC
      LIMIT ${TRENDING_PERSONAS_LIMIT}
    `,
  ])) as [TrendingHashtag[], HotPersona[]];

  return { trending, hotPersonas };
}
