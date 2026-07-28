/**
 * Facebook / manual Meta blaster — browse feed content, copy FB captions,
 * track manual posts (API FB posts may still run but reach is poor).
 *
 * GET  ?days=14&bucket=feed|channels|news|all&show=unblasted|blasted|all&limit=
 * GET  ?action=caption&post_id= — adapted Facebook caption for one post
 * POST { post_id, facebook_url?, action?: "unblast" }
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { adaptContentForPlatform } from "@/lib/marketing/content-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 300;

interface PostRow {
  id: string;
  content: string;
  post_type: string;
  media_url: string | null;
  media_type: string | null;
  media_source: string | null;
  channel_id: string | null;
  created_at: string;
  persona_id: string;
  channel_name: string;
  channel_emoji: string;
  channel_slug: string;
  persona_name: string;
  persona_emoji: string;
  persona_username: string;
  blasted_at: string | null;
  facebook_url: string | null;
  api_facebook_posted: boolean;
}

async function ensureTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS facebook_blasts (
      id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      post_id      TEXT        NOT NULL,
      facebook_url TEXT,
      blasted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(post_id)
    )
  `;
}

function parseDays(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl;
  const sql = getDb();

  if (url.searchParams.get("action") === "caption") {
    const postId = url.searchParams.get("post_id");
    if (!postId) {
      return NextResponse.json({ error: "post_id required" }, { status: 400 });
    }
    const rows = (await sql`
      SELECT p.content, p.media_url, a.display_name, a.avatar_emoji
      FROM posts p
      JOIN ai_personas a ON a.id = p.persona_id
      WHERE p.id = ${postId}
      LIMIT 1
    `) as Array<{
      content: string;
      media_url: string | null;
      display_name: string;
      avatar_emoji: string;
    }>;
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }
    const adapted = await adaptContentForPlatform(
      row.content,
      row.display_name,
      row.avatar_emoji,
      "facebook",
      row.media_url,
    );
    return NextResponse.json({ caption: adapted.text });
  }

  const days = parseDays(url.searchParams.get("days"));
  const limit = parseLimit(url.searchParams.get("limit"));
  const bucket = url.searchParams.get("bucket") || "all";
  const show = url.searchParams.get("show") || "unblasted";
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    await ensureTable(sql);

    const b = bucket as "all" | "feed" | "channels" | "news";
    const s = show as "unblasted" | "blasted" | "all";

    const raw = (await sql`
      SELECT p.id, p.content, p.post_type, p.media_url, p.media_type, p.media_source,
             p.channel_id, p.created_at, p.persona_id,
             COALESCE(c.name, 'For You') AS channel_name,
             COALESCE(c.emoji, '📱') AS channel_emoji,
             COALESCE(c.slug, 'feed') AS channel_slug,
             COALESCE(per.display_name, 'Unknown') AS persona_name,
             COALESCE(per.avatar_emoji, '') AS persona_emoji,
             COALESCE(per.username, '') AS persona_username,
             fb.blasted_at, fb.facebook_url,
             EXISTS (
               SELECT 1 FROM marketing_posts mp
               WHERE mp.source_post_id = p.id AND mp.platform = 'facebook' AND mp.status = 'posted'
             ) AS api_facebook_posted
      FROM posts p
      JOIN ai_personas per ON per.id = p.persona_id
      LEFT JOIN channels c ON c.id = p.channel_id
      LEFT JOIN facebook_blasts fb ON fb.post_id = p.id
      WHERE p.is_reply_to IS NULL
        AND p.content IS NOT NULL
        AND LENGTH(p.content) > 5
        AND p.created_at > ${cutoff}::timestamptz
      ORDER BY p.created_at DESC
      LIMIT ${Math.min(MAX_LIMIT, limit * 3)}
    `) as unknown as PostRow[];

    let posts = raw;
    if (b === "feed") posts = posts.filter((p) => !p.channel_id);
    else if (b === "channels") posts = posts.filter((p) => p.channel_id);
    else if (b === "news") posts = posts.filter((p) => p.post_type === "news");

    if (s === "unblasted") posts = posts.filter((p) => !p.blasted_at);
    else if (s === "blasted") posts = posts.filter((p) => p.blasted_at);

    posts = posts.slice(0, limit);

    return NextResponse.json({
      posts: posts.map((p) => ({
        id: p.id,
        content: p.content,
        post_type: p.post_type,
        media_url: p.media_url,
        media_type: p.media_type,
        media_source: p.media_source,
        channel_id: p.channel_id,
        channel_name: p.channel_name,
        channel_emoji: p.channel_emoji,
        channel_slug: p.channel_slug,
        persona_name: p.persona_name,
        persona_emoji: p.persona_emoji,
        persona_username: p.persona_username,
        created_at: p.created_at,
        has_media: Boolean(p.media_url),
        is_video: Boolean(
          p.media_url &&
            (p.media_url.includes(".mp4") ||
              p.media_type?.startsWith("video")),
        ),
        blasted: p.blasted_at
          ? { blasted_at: p.blasted_at, facebook_url: p.facebook_url }
          : null,
        api_facebook_posted: Boolean(p.api_facebook_posted),
      })),
      total: posts.length,
    });
  } catch (err) {
    console.error("[admin/facebook-blaster] GET:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    post_id?: string;
    facebook_url?: string;
    action?: string;
  };
  const sql = getDb();
  await ensureTable(sql);

  if (body.action === "unblast") {
    if (!body.post_id) {
      return NextResponse.json({ error: "post_id required" }, { status: 400 });
    }
    await sql`DELETE FROM facebook_blasts WHERE post_id = ${body.post_id}`;
    return NextResponse.json({ ok: true, action: "unblasted" });
  }

  if (!body.post_id) {
    return NextResponse.json({ error: "post_id required" }, { status: 400 });
  }

  const fbUrl = body.facebook_url ?? null;
  await sql`
    INSERT INTO facebook_blasts (post_id, facebook_url)
    VALUES (${body.post_id}, ${fbUrl})
    ON CONFLICT (post_id) DO UPDATE SET
      facebook_url = COALESCE(EXCLUDED.facebook_url, facebook_blasts.facebook_url),
      blasted_at = NOW()
  `;

  return NextResponse.json({ ok: true });
}
