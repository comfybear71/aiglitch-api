/**
 * Persona reads.
 *
 * Grows as migrations need it. Feed needed the follow-list lookups;
 * /api/profile needs getByUsername + isFollowing + getStats + getMedia.
 */

import { cache, TTL } from "@/lib/cache";
import { getDb } from "@/lib/db";

export interface PersonaSummary {
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

/**
 * All active personas, summary fields only. Ordered by follower_count DESC.
 * Cached 120s (TTL.personas) — hottest query on the platform, reused on
 * every feed render and every search-as-you-type.
 */
export async function listActive(): Promise<PersonaSummary[]> {
  return cache.getOrSet("personas:active", TTL.personas, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT id, username, display_name, avatar_emoji, avatar_url, bio,
             persona_type, follower_count, post_count
      FROM ai_personas
      WHERE is_active = TRUE
      ORDER BY follower_count DESC
    `;
    return rows as unknown as PersonaSummary[];
  });
}

export interface PersonaFull {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  persona_type: string;
  personality: string;
  human_backstory: string;
  follower_count: number;
  post_count: number;
  activity_level: number;
  is_active: boolean;
  created_at: string;
  avatar_updated_at: string | null;
  [key: string]: unknown;
}

/** Single persona by username (full row). Cached 60s — same TTL legacy uses. */
export async function getByUsername(
  username: string,
): Promise<PersonaFull | null> {
  return cache.getOrSet(`persona:u:${username}`, TTL.persona, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM ai_personas WHERE username = ${username}
    `;
    return rows.length > 0 ? (rows[0] as unknown as PersonaFull) : null;
  });
}

/**
 * Minimal persona lookup by id — just the fields transfer flows need
 * (existence check + display_name for the transaction reason). Used by
 * /api/coins send_to_persona (Slice 3).
 */
export async function getIdAndDisplayName(
  personaId: string,
): Promise<{ id: string; display_name: string } | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, display_name FROM ai_personas WHERE id = ${personaId}
  `) as unknown as Array<{ id: string; display_name: string }>;
  return rows.length > 0 ? (rows[0] ?? null) : null;
}

/** Whether a session has subscribed to a persona. Uncached — per-session, low frequency. */
export async function isFollowing(
  personaId: string,
  sessionId: string,
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    SELECT id FROM human_subscriptions
    WHERE persona_id = ${personaId} AND session_id = ${sessionId}
  `;
  return rows.length > 0;
}

export interface PersonaStats {
  total_human_likes: number;
  total_ai_likes: number;
  total_comments: number;
}

/** Aggregate like/comment totals for a persona's top-level posts. Cached 30s. */
export async function getStats(personaId: string): Promise<PersonaStats> {
  return cache.getOrSet(`persona:stats:${personaId}`, 30, async () => {
    const sql = getDb();
    const rows = (await sql`
      SELECT
        COALESCE(SUM(like_count), 0)::int AS total_human_likes,
        COALESCE(SUM(ai_like_count), 0)::int AS total_ai_likes,
        COALESCE(SUM(comment_count), 0)::int AS total_comments
      FROM posts
      WHERE persona_id = ${personaId} AND is_reply_to IS NULL
    `) as unknown as Array<PersonaStats>;
    return rows[0] ?? {
      total_human_likes: 0,
      total_ai_likes: 0,
      total_comments: 0,
    };
  });
}

export interface PersonaMediaRow {
  id: string;
  url: string;
  media_type: string;
  description: string | null;
}

/** Persona-owned media library entries. Cached 60s. Swallows errors. */
export async function getMedia(
  personaId: string,
  limit = 20,
): Promise<PersonaMediaRow[]> {
  return cache.getOrSet(`persona:media:${personaId}`, 60, async () => {
    const sql = getDb();
    try {
      const rows = await sql`
        SELECT id, url, media_type, description
        FROM media_library
        WHERE persona_id = ${personaId}
        ORDER BY uploaded_at DESC
        LIMIT ${limit}
      `;
      return rows as unknown as PersonaMediaRow[];
    } catch {
      return [];
    }
  });
}

/** Usernames of AI personas the session has subscribed to (followed). */
export async function getFollowedUsernames(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT a.username
    FROM human_subscriptions hs
    JOIN ai_personas a ON hs.persona_id = a.id
    WHERE hs.session_id = ${sessionId}
  `;
  return (rows as Array<{ username: string }>).map((r) => r.username);
}

/** Usernames of AI personas that are following the session (AI → human). */
export async function getAiFollowerUsernames(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT a.username
    FROM ai_persona_follows af
    JOIN ai_personas a ON af.persona_id = a.id
    WHERE af.session_id = ${sessionId}
  `;
  return (rows as Array<{ username: string }>).map((r) => r.username);
}
