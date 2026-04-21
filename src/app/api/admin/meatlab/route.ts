/**
 * Admin MeatLab review queue.
 *
 *   GET ?status=pending|approved|rejected&limit=N
 *     Lists submissions joined with the human creator's public profile
 *     (display name, handle, socials). Always returns a status-counts
 *     rollup so the review UI can show all four tabs from a single call.
 *
 *   POST { id, action: "approve" | "reject", reject_reason? }
 *     - approve: creates a post under The Architect (glitch-000,
 *       persona_id NOT NULL constraint) with
 *       post_type='meatlab' + media_source='meatlab'. Real authorship
 *       lives in `posts.meatbag_author_id` so the feed + PostCard can
 *       render the meat bag's name instead of The Architect.
 *     - reject: sets status + optional reject_reason.
 *
 * Schema safety: creates `meatlab_submissions` + adds
 * `posts.meatbag_author_id` on every GET so fresh envs work without a
 * migration pass. Backfill statement wires old approved submissions to
 * their creators — idempotent thanks to the NULL guard.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

const ARCHITECT_ID = "glitch-000";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function ensureSchema(): Promise<void> {
  const sql = getDb();
  await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS meatbag_author_id TEXT`.catch(() => {});
  await sql`
    CREATE TABLE IF NOT EXISTS meatlab_submissions (
      id             TEXT         PRIMARY KEY,
      session_id     TEXT         NOT NULL,
      user_id        TEXT,
      title          TEXT         NOT NULL DEFAULT '',
      description    TEXT         NOT NULL DEFAULT '',
      media_url      TEXT         NOT NULL,
      media_type     TEXT         NOT NULL DEFAULT 'image',
      thumbnail_url  TEXT,
      ai_tool        TEXT,
      tags           TEXT,
      status         TEXT         NOT NULL DEFAULT 'pending',
      reject_reason  TEXT,
      like_count     INTEGER      NOT NULL DEFAULT 0,
      ai_like_count  INTEGER      NOT NULL DEFAULT 0,
      comment_count  INTEGER      NOT NULL DEFAULT 0,
      view_count     INTEGER      NOT NULL DEFAULT 0,
      share_count    INTEGER      NOT NULL DEFAULT 0,
      feed_post_id   TEXT,
      approved_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `.catch(() => {});
}

async function backfillAuthorIds(): Promise<void> {
  // Idempotent — only updates rows that are still missing meatbag_author_id.
  const sql = getDb();
  await sql`
    UPDATE posts p
    SET meatbag_author_id = m.user_id
    FROM meatlab_submissions m
    WHERE p.id = m.feed_post_id
      AND p.post_type = 'meatlab'
      AND p.meatbag_author_id IS NULL
      AND m.user_id IS NOT NULL
  `.catch((err) => {
    console.error("[admin/meatlab] backfill failed:", err instanceof Error ? err.message : err);
  });
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

// ── GET ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const status = request.nextUrl.searchParams.get("status") || "pending";
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));

  await ensureSchema();
  await backfillAuthorIds();

  const submissions = await sql`
    SELECT m.*,
      h.display_name AS creator_name,
      h.username     AS creator_username,
      h.avatar_emoji AS creator_emoji,
      h.avatar_url   AS creator_avatar_url,
      h.x_handle, h.instagram_handle, h.tiktok_handle, h.youtube_handle, h.website_url
    FROM meatlab_submissions m
    LEFT JOIN human_users h ON h.id = m.user_id
    WHERE m.status = ${status}
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `;

  const counts = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
    FROM meatlab_submissions
  `) as unknown as { pending: number; approved: number; rejected: number }[];

  return NextResponse.json({
    status,
    counts: counts[0] ?? { pending: 0, approved: 0, rejected: 0 },
    total: submissions.length,
    submissions,
  });
}

// ── POST: approve / reject ─────────────────────────────────────────────

interface SubmissionRow {
  id: string;
  title: string;
  description: string;
  media_url: string;
  media_type: string;
  ai_tool: string | null;
  user_id: string | null;
  creator_name: string | null;
  creator_username: string | null;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    action?: "approve" | "reject";
    reject_reason?: string;
  };
  const { id, action, reject_reason } = body;

  if (!id || !action) {
    return NextResponse.json(
      { error: "id and action (approve/reject) required" },
      { status: 400 },
    );
  }

  if (action === "approve") {
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS meatbag_author_id TEXT`.catch(() => {});

    const subRows = (await sql`
      SELECT m.id, m.title, m.description, m.media_url, m.media_type, m.ai_tool,
             m.user_id,
             h.display_name AS creator_name,
             h.username     AS creator_username
      FROM meatlab_submissions m
      LEFT JOIN human_users h ON h.id = m.user_id
      WHERE m.id = ${id}
      LIMIT 1
    `) as unknown as SubmissionRow[];
    const sub = subRows[0];
    if (!sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 });
    }

    // PostCard renders author natively from meatbag_author_id — no prefix
    // needed. Keep the content tight.
    const toolLine = sub.ai_tool ? `\n\nCreated with ${sub.ai_tool}` : "";
    const content = ((sub.title ? `${sub.title}\n\n` : "") + (sub.description || "") + toolLine).trim();
    const postId = randomUUID();

    try {
      await sql`
        INSERT INTO posts
          (id, persona_id, meatbag_author_id, content, post_type,
           media_url, media_type, media_source, hashtags, created_at)
        VALUES
          (${postId}, ${ARCHITECT_ID}, ${sub.user_id}, ${content}, 'meatlab',
           ${sub.media_url}, ${sub.media_type}, 'meatlab',
           ${"#MeatLab #AIArt #HumanCreators"}, NOW())
      `;
    } catch (err) {
      console.error(
        "[admin/meatlab] failed to create feed post:",
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json({ error: "Failed to create feed post" }, { status: 500 });
    }

    await sql`
      UPDATE meatlab_submissions
      SET status = 'approved',
          feed_post_id = ${postId},
          approved_at  = NOW(),
          updated_at   = NOW()
      WHERE id = ${id}
    `;

    const creatorLabel = sub.creator_name || sub.creator_username || "Anonymous Meat Bag";
    return NextResponse.json({
      success: true,
      id,
      status: "approved",
      post_id: postId,
      message: `Approved! Post created in feed as "${creatorLabel}'s AI Creation"`,
    });
  }

  if (action === "reject") {
    await sql`
      UPDATE meatlab_submissions
      SET status        = 'rejected',
          reject_reason = ${reject_reason ?? null},
          updated_at    = NOW()
      WHERE id = ${id}
    `;
    return NextResponse.json({ success: true, id, status: "rejected" });
  }

  return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
}
