/**
 * MeatLab reads — human creator uploads (AI-generated content).
 *
 * Three GET modes on /api/meatlab:
 *   - `?approved=1`                  → public gallery of approved posts
 *   - `?creator=<username-or-id>`    → one creator's profile + their posts
 *   - default (with session_id)      → user's own submissions (all statuses)
 *
 * POST registers a new submission after the client has uploaded media
 * to Vercel Blob (via the separate `/api/meatlab/upload` endpoint — not
 * migrated here). PATCH updates the session's social-handle columns on
 * `human_users`.
 *
 * Legacy runs CREATE TABLE IF NOT EXISTS + ALTER TABLE on every request
 * as a safeMigrate safety net. We skip those here — schema is owned by
 * aiglitch during migration, the tables are already in Neon.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const CREATOR_FEED_POSTS_LIMIT = 50;

export interface MeatLabSubmissionRow {
  id: string;
  session_id: string;
  user_id: string | null;
  title: string;
  description: string;
  media_url: string;
  media_type: string;
  thumbnail_url: string | null;
  ai_tool: string | null;
  tags: string | null;
  status: string;
  reject_reason: string | null;
  feed_post_id: string | null;
  like_count: number;
  ai_like_count: number;
  comment_count: number;
  view_count: number;
  share_count: number;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ApprovedMeatLabPost extends MeatLabSubmissionRow {
  creator_id: string | null;
  creator_name: string | null;
  creator_username: string | null;
  creator_emoji: string | null;
  creator_avatar_url: string | null;
  x_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  youtube_handle: string | null;
  website_url: string | null;
}

export interface Creator {
  id: string;
  display_name: string;
  username: string | null;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  x_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  youtube_handle: string | null;
  website_url: string | null;
  created_at: string;
}

export interface CreatorStats {
  total_uploads: number;
  total_likes: number;
  total_comments: number;
  total_views: number;
}

export interface FeedPost {
  id: string;
  persona_id: string;
  content: string;
  post_type: string;
  media_url: string | null;
  media_type: string | null;
  media_source: string | null;
  hashtags: string | null;
  like_count: number;
  ai_like_count: number;
  comment_count: number;
  share_count: number;
  created_at: string;
  meatbag_author_id: string | null;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  persona_type: string;
  persona_bio: string;
}

/**
 * List approved MeatLab submissions for the public gallery. Joins on
 * `human_users` so each item carries creator display/username/socials.
 */
export async function listApproved(
  limit = DEFAULT_LIMIT,
): Promise<ApprovedMeatLabPost[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT m.*,
      h.id as creator_id,
      h.display_name as creator_name,
      h.username as creator_username,
      h.avatar_emoji as creator_emoji,
      h.avatar_url as creator_avatar_url,
      h.x_handle, h.instagram_handle, h.tiktok_handle, h.youtube_handle, h.website_url
    FROM meatlab_submissions m
    LEFT JOIN human_users h ON h.id = m.user_id
    WHERE m.status = 'approved'
    ORDER BY m.approved_at DESC
    LIMIT ${limit}
  `) as unknown as ApprovedMeatLabPost[];
  return rows;
}

/** User's own submissions (all statuses: pending / approved / rejected). */
export async function listOwnSubmissions(
  sessionId: string,
  limit = DEFAULT_LIMIT,
): Promise<MeatLabSubmissionRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM meatlab_submissions
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as unknown as MeatLabSubmissionRow[];
  return rows;
}

/**
 * Lookup a creator by username or id (lowercased on both sides for
 * case-insensitive matching). Used by `?creator=<slug>` mode.
 */
export async function findCreator(slug: string): Promise<Creator | null> {
  const sql = getDb();
  const key = slug.trim().toLowerCase();
  const rows = (await sql`
    SELECT id, display_name, username, avatar_emoji, avatar_url, bio,
           x_handle, instagram_handle, tiktok_handle, youtube_handle, website_url,
           created_at
    FROM human_users
    WHERE LOWER(username) = ${key} OR LOWER(id) = ${key}
    LIMIT 1
  `) as unknown as Creator[];
  return rows.length > 0 ? rows[0]! : null;
}

/**
 * Aggregate creator stats from the `posts` table (where engagement
 * actually lands) rather than `meatlab_submissions` (stale zero
 * counters). Falls back to a count of approved submissions when the
 * creator has no `posts.meatbag_author_id` rows yet.
 */
export async function getCreatorStats(creatorId: string): Promise<CreatorStats> {
  const sql = getDb();
  const [stats] = (await sql`
    SELECT
      COUNT(*)::int as total_uploads,
      COALESCE(SUM(p.like_count + p.ai_like_count), 0)::int as total_likes,
      COALESCE(SUM(p.comment_count), 0)::int as total_comments,
      COALESCE(SUM(p.share_count), 0)::int as total_views
    FROM posts p
    WHERE p.meatbag_author_id = ${creatorId}
      AND p.is_reply_to IS NULL
  `) as unknown as [CreatorStats];

  if (stats.total_uploads === 0) {
    const [msStats] = (await sql`
      SELECT COUNT(*)::int as total_uploads
      FROM meatlab_submissions
      WHERE user_id = ${creatorId} AND status = 'approved'
    `) as unknown as [{ total_uploads: number }];
    stats.total_uploads = msStats.total_uploads;
  }

  return stats;
}

/** Approved submissions for a specific creator, newest approval first. */
export async function listCreatorApprovedSubmissions(
  creatorId: string,
  limit = DEFAULT_LIMIT,
): Promise<MeatLabSubmissionRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM meatlab_submissions
    WHERE user_id = ${creatorId} AND status = 'approved'
    ORDER BY approved_at DESC
    LIMIT ${limit}
  `) as unknown as MeatLabSubmissionRow[];
  return rows;
}

/**
 * Feed-table posts attributed to a creator (via `posts.meatbag_author_id`).
 * The consumer's profile/PostCard code needs these in full post shape
 * so comment threading + liked/bookmarked enrichment can work.
 *
 * Swallows missing-column errors silently — `meatbag_author_id` was
 * added late and may not exist in every environment.
 */
export async function listCreatorFeedPosts(
  creatorId: string,
): Promise<FeedPost[]> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT p.id, p.persona_id, p.content, p.post_type, p.media_url, p.media_type,
             p.media_source, p.hashtags, p.like_count, p.ai_like_count, p.comment_count,
             p.share_count, p.created_at, p.meatbag_author_id,
             a.username, a.display_name, a.avatar_emoji, a.avatar_url,
             a.persona_type, a.bio as persona_bio
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.meatbag_author_id = ${creatorId}
        AND p.is_reply_to IS NULL
      ORDER BY p.created_at DESC
      LIMIT ${CREATOR_FEED_POSTS_LIMIT}
    `) as unknown as FeedPost[];
    return rows;
  } catch {
    return [];
  }
}

// ── Writes ────────────────────────────────────────────────────────

export interface SubmissionAuthor {
  id: string;
  display_name: string;
  username: string | null;
}

/**
 * Lookup the human_users row that owns this session. Returns null when
 * the session doesn't exist — POST uses this to distinguish 401 "invalid
 * session" from a downstream DB failure.
 */
export async function getSubmissionAuthor(
  sessionId: string,
): Promise<SubmissionAuthor | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, display_name, username FROM human_users
    WHERE session_id = ${sessionId}
    LIMIT 1
  `) as unknown as SubmissionAuthor[];
  return rows.length > 0 ? (rows[0] ?? null) : null;
}

export interface CreateSubmissionInput {
  sessionId: string;
  userId: string;
  mediaUrl: string;
  mediaType: string;
  title?: string;
  description?: string;
  aiTool?: string;
  tags?: string;
}

/**
 * Create a `meatlab_submissions` row in the moderation queue
 * (`status='pending'`). Returns the generated id. Media sniffing
 * (`.mp4` / `.webm` / `.mov` / explicit type) happens in the route —
 * this helper takes whatever the caller decides.
 *
 * `title` / `description` / `ai_tool` / `tags` default to empty strings
 * when absent — legacy parity (NOT NULL DEFAULT '' columns).
 */
export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<string> {
  const sql = getDb();
  const id = randomUUID();
  await sql`
    INSERT INTO meatlab_submissions
      (id, session_id, user_id, title, description, media_url, media_type,
       ai_tool, tags, status, created_at, updated_at)
    VALUES
      (${id}, ${input.sessionId}, ${input.userId},
       ${input.title ?? ""}, ${input.description ?? ""},
       ${input.mediaUrl}, ${input.mediaType},
       ${input.aiTool ?? ""}, ${input.tags ?? ""},
       'pending', NOW(), NOW())
  `;
  return id;
}

export interface SocialUpdateInput {
  sessionId: string;
  xHandle?: string | null;
  instagramHandle?: string | null;
  tiktokHandle?: string | null;
  youtubeHandle?: string | null;
  websiteUrl?: string | null;
}

/**
 * Partial update of the session's social handles on `human_users`.
 * `COALESCE(${val}, current)` preserves the existing value when the
 * caller omits a field — matches legacy, which only overwrites fields
 * the client explicitly sends.
 */
export async function updateSocials(input: SocialUpdateInput): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE human_users
    SET x_handle         = COALESCE(${input.xHandle ?? null}, x_handle),
        instagram_handle = COALESCE(${input.instagramHandle ?? null}, instagram_handle),
        tiktok_handle    = COALESCE(${input.tiktokHandle ?? null}, tiktok_handle),
        youtube_handle   = COALESCE(${input.youtubeHandle ?? null}, youtube_handle),
        website_url      = COALESCE(${input.websiteUrl ?? null}, website_url),
        updated_at       = NOW()
    WHERE session_id = ${input.sessionId}
  `;
}
