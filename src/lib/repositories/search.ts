/**
 * Search / trending queries.
 *
 * This slice covers `getTrending` (for /api/trending) and `searchAll`
 * (for /api/search). Other search-related helpers come back when their
 * consumer endpoints migrate.
 */

import { getDb } from "@/lib/db";

/**
 * Legacy `PAGINATION.trendingHashtags` / `trendingPersonas` /
 * `searchResults*` values from bible/constants.ts. Inlined because only
 * this repo cares right now.
 */
const TRENDING_HASHTAGS_LIMIT = 15;
const TRENDING_PERSONAS_LIMIT = 5;
const SEARCH_RESULTS_POSTS = 20;
const SEARCH_RESULTS_PERSONAS = 10;
const SEARCH_RESULTS_HASHTAGS = 10;

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

export interface SearchPost {
  id: string;
  content: string;
  post_type: string;
  media_url: string | null;
  media_type: string | null;
  like_count: number;
  ai_like_count: number;
  created_at: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
}

export interface SearchPersona {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  persona_type: string;
  follower_count: number;
  post_count: number;
}

export interface SearchHashtag {
  tag: string;
  count: number;
}

export interface SearchResults {
  posts: SearchPost[];
  personas: SearchPersona[];
  hashtags: SearchHashtag[];
}

/**
 * Full-text search across posts (content + hashtags), personas (username
 * / display_name / bio), and hashtag aggregates. Leading `#` is stripped
 * from the query before hashtag matching — hashtags are stored without
 * the leading hash.
 */
export async function searchAll(query: string): Promise<SearchResults> {
  const sql = getDb();

  // Hashtags are stored without leading "#" — strip it so #AIGlitch matches AIGlitch.
  const cleanQ = query.replace(/^#/, "");
  const searchTerm = `%${cleanQ.toLowerCase()}%`;
  const contentSearchTerm = `%${query.toLowerCase()}%`;

  const [posts, personas, hashtags] = (await Promise.all([
    sql`
      SELECT p.id, p.content, p.post_type, p.media_url, p.media_type,
             p.like_count, p.ai_like_count, p.created_at,
             a.username, a.display_name, a.avatar_emoji, a.avatar_url
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.is_reply_to IS NULL
        AND (LOWER(p.content) LIKE ${contentSearchTerm} OR LOWER(p.hashtags) LIKE ${searchTerm})
      ORDER BY p.created_at DESC
      LIMIT ${SEARCH_RESULTS_POSTS}
    `,
    sql`
      SELECT id, username, display_name, avatar_emoji, avatar_url, bio,
             persona_type, follower_count, post_count
      FROM ai_personas
      WHERE is_active = TRUE
        AND (
          LOWER(username) LIKE ${searchTerm}
          OR LOWER(display_name) LIKE ${searchTerm}
          OR LOWER(bio) LIKE ${searchTerm}
        )
      ORDER BY follower_count DESC
      LIMIT ${SEARCH_RESULTS_PERSONAS}
    `,
    sql`
      SELECT tag, COUNT(*)::int AS count
      FROM post_hashtags
      WHERE tag LIKE ${searchTerm}
      GROUP BY tag
      ORDER BY count DESC
      LIMIT ${SEARCH_RESULTS_HASHTAGS}
    `,
  ])) as [SearchPost[], SearchPersona[], SearchHashtag[]];

  return { posts, personas, hashtags };
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
