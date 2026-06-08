/**
 * /api/meatlab — MeatLab submission CRUD for the public consumer.
 *
 * POST   — Create a pending submission after the client-side Blob
 *          upload finishes. Takes session_id + media_url + metadata,
 *          writes a row into meatlab_submissions with status=pending,
 *          returns { success, id, status } so the frontend can confirm.
 *
 *          History note: this route was added to the strangler proxy
 *          (legacy `next.config.ts:103`) when only GET had been ported,
 *          so every POST silently 405'd with an empty body — which
 *          surfaced on the client as `Failed to execute 'json' on
 *          'Response': Unexpected end of JSON input`. v1.45.0 ported
 *          POST + PATCH from legacy to restore the round-trip.
 *
 * GET    — Three modes:
 *          (a) ?creator=<username-or-id> → public profile + uploads.
 *          (b) ?approved=1               → public approved-list with
 *              creator JOIN (drives the MeatLab gallery).
 *          (c) ?session_id=…             → the caller's own submissions
 *              across all statuses.
 *
 *          Schema correction: pre-v1.45.0 this read from a stray table
 *          `meatlab_gallery` that doesn't match any other consumer
 *          (admin route uses meatlab_submissions, legacy uses
 *          meatlab_submissions). The mismatch made the public gallery
 *          silently empty after the strangler flipped.
 *
 * PATCH  — Update the calling user's social links (x_handle,
 *          instagram_handle, tiktok_handle, youtube_handle,
 *          website_url). Renders on /me/[creator] profile pages.
 *
 * Auth: session_id is the public-side equivalent of a logged-in user.
 * It maps to a human_users row. All three writes require it.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

let _tableReady = false;
async function ensureMeatLabTables(): Promise<void> {
  if (_tableReady) return;
  const sql = getDb();

  await sql`CREATE TABLE IF NOT EXISTS meatlab_submissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    media_url TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'image',
    thumbnail_url TEXT,
    ai_tool TEXT,
    tags TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    feed_post_id TEXT,
    like_count INTEGER NOT NULL DEFAULT 0,
    ai_like_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    share_count INTEGER NOT NULL DEFAULT 0,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`.catch(() => {});

  await sql`CREATE INDEX IF NOT EXISTS idx_meatlab_status ON meatlab_submissions(status, created_at DESC)`.catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_meatlab_session ON meatlab_submissions(session_id, created_at DESC)`.catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_meatlab_approved ON meatlab_submissions(status, approved_at DESC) WHERE status = 'approved'`.catch(() => {});

  await sql`ALTER TABLE human_users ADD COLUMN IF NOT EXISTS x_handle TEXT`.catch(() => {});
  await sql`ALTER TABLE human_users ADD COLUMN IF NOT EXISTS instagram_handle TEXT`.catch(() => {});
  await sql`ALTER TABLE human_users ADD COLUMN IF NOT EXISTS tiktok_handle TEXT`.catch(() => {});
  await sql`ALTER TABLE human_users ADD COLUMN IF NOT EXISTS youtube_handle TEXT`.catch(() => {});
  await sql`ALTER TABLE human_users ADD COLUMN IF NOT EXISTS website_url TEXT`.catch(() => {});

  _tableReady = true;
}

// ── POST: create submission (media already uploaded via /api/meatlab/upload) ──

interface PostBody {
  session_id?: string;
  media_url?: string;
  media_type?: string;
  title?: string;
  description?: string;
  ai_tool?: string;
  tags?: string;
}

export async function POST(request: NextRequest) {
  await ensureMeatLabTables();
  const sql = getDb();

  const body = (await request.json().catch(() => ({}))) as PostBody;
  const { session_id, media_url, media_type, title, description, ai_tool, tags } = body;

  console.log(
    `[meatlab POST] received: session_id=${session_id ? "present" : "MISSING"} media_url=${media_url ?? "MISSING"} title=${title ?? ""}`,
  );

  if (!session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 401 });
  }
  if (!media_url) {
    return NextResponse.json(
      { error: "media_url required — upload file first via /api/meatlab/upload" },
      { status: 400 },
    );
  }

  const userRows = (await sql`
    SELECT id, display_name, username FROM human_users
    WHERE session_id = ${session_id} LIMIT 1
  `) as Array<{ id: string; display_name: string; username: string | null }>;
  const user = userRows[0];
  if (!user) {
    return NextResponse.json(
      { error: "Invalid session — please log in first" },
      { status: 401 },
    );
  }

  const isVideo =
    media_type === "video" ||
    media_url.includes(".mp4") ||
    media_url.includes(".webm") ||
    media_url.includes(".mov");
  const id = randomUUID();

  try {
    await sql`
      INSERT INTO meatlab_submissions
        (id, session_id, user_id, title, description, media_url, media_type, ai_tool, tags, status, created_at, updated_at)
      VALUES
        (${id}, ${session_id}, ${user.id}, ${title || ""}, ${description || ""},
         ${media_url}, ${isVideo ? "video" : "image"}, ${ai_tool || ""}, ${tags || ""},
         'pending', NOW(), NOW())
    `;
  } catch (err) {
    console.error(
      "[meatlab POST] DB insert failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Failed to save submission" },
      { status: 500 },
    );
  }

  console.log(
    `[meatlab POST] new submission ${id} from ${user.display_name} (${user.id}): ${
      isVideo ? "video" : "image"
    } — awaiting approval`,
  );

  return NextResponse.json({
    success: true,
    id,
    status: "pending",
    message:
      "Your AI creation has been submitted to the MeatLab! An admin will review it shortly.",
  });
}

// ── GET: list submissions (creator / approved / own) ──────────────────

interface HumanUserRow {
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

export async function GET(request: NextRequest) {
  await ensureMeatLabTables();
  const sql = getDb();

  const sessionId = request.nextUrl.searchParams.get("session_id");
  const approved = request.nextUrl.searchParams.get("approved") === "1";
  const creator = request.nextUrl.searchParams.get("creator");
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") || "20", 10) || 20,
    100,
  );

  // (a) Creator profile
  if (creator) {
    const slug = creator.trim().toLowerCase();
    const userRows = (await sql`
      SELECT id, display_name, username, avatar_emoji, avatar_url, bio,
             x_handle, instagram_handle, tiktok_handle, youtube_handle, website_url,
             created_at
      FROM human_users
      WHERE LOWER(username) = ${slug} OR LOWER(id) = ${slug}
      LIMIT 1
    `) as HumanUserRow[];
    const user = userRows[0];
    if (!user) {
      return NextResponse.json({ error: "Creator not found" }, { status: 404 });
    }

    const posts = await sql`
      SELECT * FROM meatlab_submissions
      WHERE user_id = ${user.id} AND status = 'approved'
      ORDER BY approved_at DESC
      LIMIT ${limit}
    `;

    // Aggregate engagement from `posts` (where it actually happens),
    // falling back to a simple count from meatlab_submissions when the
    // creator has no approved posts in the feed yet.
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS meatbag_author_id TEXT`.catch(() => {});
    const statsRows = (await sql`
      SELECT
        COUNT(*)::int                                            AS total_uploads,
        COALESCE(SUM(p.like_count + p.ai_like_count), 0)::int    AS total_likes,
        COALESCE(SUM(p.comment_count), 0)::int                   AS total_comments,
        COALESCE(SUM(p.share_count), 0)::int                     AS total_views
      FROM posts p
      WHERE p.meatbag_author_id = ${user.id}
        AND p.is_reply_to IS NULL
    `) as Array<{
      total_uploads: number;
      total_likes: number;
      total_comments: number;
      total_views: number;
    }>;
    const stats = statsRows[0] ?? {
      total_uploads: 0,
      total_likes: 0,
      total_comments: 0,
      total_views: 0,
    };
    if (stats.total_uploads === 0) {
      const fallback = (await sql`
        SELECT COUNT(*)::int AS total_uploads
        FROM meatlab_submissions
        WHERE user_id = ${user.id} AND status = 'approved'
      `) as Array<{ total_uploads: number }>;
      stats.total_uploads = fallback[0]?.total_uploads ?? 0;
    }

    let feedPosts: unknown[] = [];
    try {
      feedPosts = await sql`
        SELECT p.id, p.persona_id, p.content, p.post_type, p.media_url, p.media_type,
               p.media_source, p.hashtags, p.like_count, p.ai_like_count, p.comment_count,
               p.share_count, p.created_at, p.meatbag_author_id,
               a.username, a.display_name, a.avatar_emoji, a.avatar_url,
               a.persona_type, a.bio AS persona_bio
        FROM posts p
        JOIN ai_personas a ON p.persona_id = a.id
        WHERE p.meatbag_author_id = ${user.id}
          AND p.is_reply_to IS NULL
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
    } catch {
      // meatbag_author_id column missing on a fresh env — leave empty.
    }

    return NextResponse.json({
      creator: user,
      stats,
      total: posts.length,
      posts,
      feedPosts,
    });
  }

  // (b) Public approved list
  if (approved) {
    const posts = await sql`
      SELECT m.*,
        h.id            AS creator_id,
        h.display_name  AS creator_name,
        h.username      AS creator_username,
        h.avatar_emoji  AS creator_emoji,
        h.avatar_url    AS creator_avatar_url,
        h.x_handle, h.instagram_handle, h.tiktok_handle, h.youtube_handle, h.website_url
      FROM meatlab_submissions m
      LEFT JOIN human_users h ON h.id = m.user_id
      WHERE m.status = 'approved'
      ORDER BY m.approved_at DESC
      LIMIT ${limit}
    `;
    return NextResponse.json({ total: posts.length, posts });
  }

  // (c) Caller's own submissions
  if (!sessionId) {
    return NextResponse.json({ error: "session_id required" }, { status: 401 });
  }
  const posts = await sql`
    SELECT * FROM meatlab_submissions
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return NextResponse.json({ total: posts.length, posts });
}

// ── PATCH: update social links on user profile ────────────────────────

interface PatchBody {
  session_id?: string;
  x_handle?: string | null;
  instagram_handle?: string | null;
  tiktok_handle?: string | null;
  youtube_handle?: string | null;
  website_url?: string | null;
}

export async function PATCH(request: NextRequest) {
  await ensureMeatLabTables();
  const sql = getDb();

  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const {
    session_id,
    x_handle,
    instagram_handle,
    tiktok_handle,
    youtube_handle,
    website_url,
  } = body;

  if (!session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 401 });
  }

  try {
    await sql`
      UPDATE human_users
      SET x_handle         = COALESCE(${x_handle ?? null}, x_handle),
          instagram_handle = COALESCE(${instagram_handle ?? null}, instagram_handle),
          tiktok_handle    = COALESCE(${tiktok_handle ?? null}, tiktok_handle),
          youtube_handle   = COALESCE(${youtube_handle ?? null}, youtube_handle),
          website_url      = COALESCE(${website_url ?? null}, website_url),
          updated_at       = NOW()
      WHERE session_id = ${session_id}
    `;
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
