/**
 * GET  /api/admin/tiktok-blaster?days=14&channel=<slug>&limit=100
 *   Admin UI feed for manual TikTok cross-posting. Returns channel
 *   videos (posts with .mp4 media_url) from the last N days, with a
 *   left-join onto `tiktok_blasts` so the dashboard can show which
 *   posts have already been blasted (and their TikTok URL).
 *
 * POST /api/admin/tiktok-blaster
 *   Mark a post as blasted (default) or unblast it:
 *     { post_id, tiktok_url? }                → upsert blast row
 *     { post_id, action: "unblast" }          → delete blast row
 *
 * The `tiktok_blasts` table has a UNIQUE(post_id) constraint so
 * repeated posts update instead of duplicating. Table is created on
 * first call (CREATE IF NOT EXISTS) — no migration needed.
 *
 * NB: TikTok API is dead — this is manual tracking only. Do not
 * restore automation (per CLAUDE.md safety rule #8).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface VideoRow {
  id: string;
  content: string;
  media_url: string;
  media_type: string | null;
  channel_id: string | null;
  created_at: string;
  persona_id: string;
  channel_name: string;
  channel_emoji: string;
  channel_slug: string;
  persona_name: string;
  persona_emoji: string;
  blasted_at: string | null;
  tiktok_url: string | null;
}

async function ensureTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS tiktok_blasts (
      id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      post_id    TEXT        NOT NULL,
      tiktok_url TEXT,
      blasted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

  const sql = getDb();
  const url = request.nextUrl;
  const days = parseDays(url.searchParams.get("days"));
  const channel = url.searchParams.get("channel") || "all";
  const limit = parseLimit(url.searchParams.get("limit"));

  try {
    await ensureTable(sql);

    // Compute cutoff in JS — sidesteps Neon's parameterised INTERVAL quirks
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const videos = (channel === "all"
      ? await sql`
          SELECT p.id, p.content, p.media_url, p.media_type, p.channel_id, p.created_at, p.persona_id,
                 COALESCE(c.name, 'Main Feed') AS channel_name,
                 COALESCE(c.emoji, '')        AS channel_emoji,
                 COALESCE(c.slug, 'feed')     AS channel_slug,
                 COALESCE(per.display_name, 'Unknown') AS persona_name,
                 COALESCE(per.avatar_emoji, '')        AS persona_emoji,
                 tb.blasted_at, tb.tiktok_url
          FROM posts p
          LEFT JOIN channels     c   ON c.id   = p.channel_id
          LEFT JOIN ai_personas  per ON per.id = p.persona_id
          LEFT JOIN tiktok_blasts tb ON tb.post_id = p.id
          WHERE p.media_url LIKE '%.mp4%'
            AND p.channel_id IS NOT NULL
            AND p.created_at > ${cutoff}::timestamptz
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT p.id, p.content, p.media_url, p.media_type, p.channel_id, p.created_at, p.persona_id,
                 COALESCE(c.name, 'Main Feed') AS channel_name,
                 COALESCE(c.emoji, '')        AS channel_emoji,
                 COALESCE(c.slug, 'feed')     AS channel_slug,
                 COALESCE(per.display_name, 'Unknown') AS persona_name,
                 COALESCE(per.avatar_emoji, '')        AS persona_emoji,
                 tb.blasted_at, tb.tiktok_url
          FROM posts p
          LEFT JOIN channels     c   ON c.id   = p.channel_id
          LEFT JOIN ai_personas  per ON per.id = p.persona_id
          LEFT JOIN tiktok_blasts tb ON tb.post_id = p.id
          WHERE p.media_url LIKE '%.mp4%'
            AND p.channel_id IS NOT NULL
            AND p.created_at > ${cutoff}::timestamptz
            AND c.slug = ${channel}
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as VideoRow[];

    const channels = await sql`
      SELECT id, name, emoji, slug FROM channels WHERE is_active = TRUE ORDER BY name
    `;

    return NextResponse.json({
      videos: videos.map((v) => ({
        ...v,
        blasted: v.blasted_at ? { blasted_at: v.blasted_at, tiktok_url: v.tiktok_url } : null,
      })),
      channels,
      total: videos.length,
    });
  } catch (err) {
    console.error("[admin/tiktok-blaster] GET:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    post_id?: string;
    tiktok_url?: string;
    action?: string;
  };
  const { post_id, tiktok_url, action } = body;

  const sql = getDb();

  try {
    await ensureTable(sql);

    if (action === "unblast") {
      if (!post_id) {
        return NextResponse.json({ error: "post_id required" }, { status: 400 });
      }
      await sql`DELETE FROM tiktok_blasts WHERE post_id = ${post_id}`;
      return NextResponse.json({ ok: true, action: "unblasted" });
    }

    if (!post_id) {
      return NextResponse.json({ error: "post_id required" }, { status: 400 });
    }

    const url = tiktok_url ?? null;
    await sql`
      INSERT INTO tiktok_blasts (post_id, tiktok_url)
      VALUES (${post_id}, ${url})
      ON CONFLICT (post_id) DO UPDATE
      SET tiktok_url = ${url},
          blasted_at = NOW()
    `;

    return NextResponse.json({ ok: true, action: "blasted" });
  } catch (err) {
    console.error("[admin/tiktok-blaster] POST:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
