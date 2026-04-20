/**
 * Movie directory reads.
 *
 * Two data sources merge in the route:
 *   - director_movies (blockbusters — director-crafted multi-clip films)
 *   - premiere posts (trailers — single-clip videos tagged with a genre)
 *
 * Legacy swallows "table might not exist" errors silently — preserved here
 * because `director_movies` and `multi_clip_jobs` arrive with the AI
 * engine port (Phase 5) and don't yet exist in every environment.
 */

import { getDb } from "@/lib/db";

export interface DirectorMovieRow {
  id: string;
  title: string;
  genre: string;
  director_username: string;
  director_display_name: string;
  clip_count: number;
  status: string;
  post_id: string | null;
  premiere_post_id: string | null;
  created_at: string;
  completed_clips: number | null;
  total_clips: number | null;
}

export interface PremierePostRow {
  id: string;
  content: string;
  hashtags: string;
  media_url: string;
  created_at: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  avatar_emoji: string;
  media_source: string | null;
}

/**
 * Rows from `director_movies` joined with persona display_name and clip
 * progress from multi_clip_jobs. Filters apply on genre / director_username
 * when supplied. Swallows DB errors from missing tables.
 */
export async function listDirectorMovies(
  filters: { genre?: string; director?: string } = {},
): Promise<DirectorMovieRow[]> {
  const sql = getDb();
  const { genre, director } = filters;

  try {
    if (genre && director) {
      return (await sql`
        SELECT dm.id, dm.title, dm.genre, dm.director_username, dm.clip_count, dm.status,
               dm.post_id, dm.premiere_post_id, dm.created_at,
               COALESCE(a.display_name, dm.director_username) as director_display_name,
               j.completed_clips, j.clip_count as total_clips
        FROM director_movies dm
        LEFT JOIN ai_personas a ON a.username = dm.director_username
        LEFT JOIN multi_clip_jobs j ON j.id = dm.multi_clip_job_id
        WHERE dm.genre = ${genre} AND dm.director_username = ${director}
        ORDER BY dm.created_at DESC
      `) as unknown as DirectorMovieRow[];
    }
    if (genre) {
      return (await sql`
        SELECT dm.id, dm.title, dm.genre, dm.director_username, dm.clip_count, dm.status,
               dm.post_id, dm.premiere_post_id, dm.created_at,
               COALESCE(a.display_name, dm.director_username) as director_display_name,
               j.completed_clips, j.clip_count as total_clips
        FROM director_movies dm
        LEFT JOIN ai_personas a ON a.username = dm.director_username
        LEFT JOIN multi_clip_jobs j ON j.id = dm.multi_clip_job_id
        WHERE dm.genre = ${genre}
        ORDER BY dm.created_at DESC
      `) as unknown as DirectorMovieRow[];
    }
    if (director) {
      return (await sql`
        SELECT dm.id, dm.title, dm.genre, dm.director_username, dm.clip_count, dm.status,
               dm.post_id, dm.premiere_post_id, dm.created_at,
               COALESCE(a.display_name, dm.director_username) as director_display_name,
               j.completed_clips, j.clip_count as total_clips
        FROM director_movies dm
        LEFT JOIN ai_personas a ON a.username = dm.director_username
        LEFT JOIN multi_clip_jobs j ON j.id = dm.multi_clip_job_id
        WHERE dm.director_username = ${director}
        ORDER BY dm.created_at DESC
      `) as unknown as DirectorMovieRow[];
    }
    return (await sql`
      SELECT dm.id, dm.title, dm.genre, dm.director_username, dm.clip_count, dm.status,
             dm.post_id, dm.premiere_post_id, dm.created_at,
             COALESCE(a.display_name, dm.director_username) as director_display_name,
             j.completed_clips, j.clip_count as total_clips
      FROM director_movies dm
      LEFT JOIN ai_personas a ON a.username = dm.director_username
      LEFT JOIN multi_clip_jobs j ON j.id = dm.multi_clip_job_id
      ORDER BY dm.created_at DESC
    `) as unknown as DirectorMovieRow[];
  } catch {
    return [];
  }
}

/**
 * Top 200 premiere-tagged video posts, optionally filtered to a genre via
 * its `AIGlitch<Genre>` hashtag. Excludes `director-scene` media (those
 * live inside the blockbuster timeline, not as standalone trailers).
 */
export async function listPremierePosts(
  filters: { genre?: string } = {},
): Promise<PremierePostRow[]> {
  const sql = getDb();
  const { genre } = filters;

  try {
    if (genre) {
      const genreTag = `AIGlitch${genre.charAt(0).toUpperCase() + genre.slice(1)}`;
      return (await sql`
        SELECT p.id, p.content, p.hashtags, p.media_url, p.created_at, p.media_source,
               a.username, a.display_name, a.avatar_url, a.avatar_emoji
        FROM posts p
        JOIN ai_personas a ON p.persona_id = a.id
        WHERE p.is_reply_to IS NULL
          AND (p.post_type = 'premiere' OR p.hashtags LIKE '%AIGlitchPremieres%')
          AND p.media_type = 'video' AND p.media_url IS NOT NULL
          AND p.hashtags LIKE ${"%" + genreTag + "%"}
          AND p.media_source NOT IN ('director-scene')
        ORDER BY p.created_at DESC
        LIMIT 200
      `) as unknown as PremierePostRow[];
    }
    return (await sql`
      SELECT p.id, p.content, p.hashtags, p.media_url, p.created_at, p.media_source,
             a.username, a.display_name, a.avatar_url, a.avatar_emoji
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.is_reply_to IS NULL
        AND (p.post_type = 'premiere' OR p.hashtags LIKE '%AIGlitchPremieres%')
        AND p.media_type = 'video' AND p.media_url IS NOT NULL
        AND p.media_source NOT IN ('director-scene')
      ORDER BY p.created_at DESC
      LIMIT 200
    `) as unknown as PremierePostRow[];
  } catch {
    return [];
  }
}
