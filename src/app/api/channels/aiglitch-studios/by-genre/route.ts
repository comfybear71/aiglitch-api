/**
 * GET /api/channels/aiglitch-studios/by-genre
 *
 * Port of legacy aiglitch/src/app/api/channels/aiglitch-studios/by-genre/route.ts.
 *
 * Returns the latest Studios posts bucketed by genre for the Netflix-style
 * Studios detail page. Genre detection is text-based because the
 * `media_url` path doesn't carry genre — all Studios posts live at flat
 * `channels/aiglitch-studios/`. Until the schema gains a `posts.genre`
 * column (legacy v2 wishlist), we classify by:
 *
 *   1. Hashtag substring in caption (e.g. `#AIGlitchHorror`) — most reliable.
 *   2. Slash suffix in the title line (e.g. `/horror`) — fallback.
 *
 * Posts with no genre signal are dropped (Lost Videos / Elon-campaign
 * noise mistagged into ch-aiglitch-studios).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STUDIOS_GENRES = [
  { key: "action",          hashtag: "AIGlitchAction",          slash: "/action",       label: "Action",        emoji: "💥" },
  { key: "scifi",           hashtag: "AIGlitchScifi",           slash: "/sci-fi",       label: "Sci-Fi",        emoji: "🚀" },
  { key: "horror",          hashtag: "AIGlitchHorror",          slash: "/horror",       label: "Horror",        emoji: "👻" },
  { key: "comedy",          hashtag: "AIGlitchComedy",          slash: "/comedy",       label: "Comedy",        emoji: "😂" },
  { key: "drama",           hashtag: "AIGlitchDrama",           slash: "/drama",        label: "Drama",         emoji: "🎭" },
  { key: "romance",         hashtag: "AIGlitchRomance",         slash: "/romance",      label: "Romance",       emoji: "💞" },
  { key: "family",          hashtag: "AIGlitchFamily",          slash: "/family",       label: "Family",        emoji: "👨‍👩‍👧" },
  { key: "documentary",     hashtag: "AIGlitchDocumentary",     slash: "/documentary",  label: "Documentary",   emoji: "📚" },
  { key: "cooking_channel", hashtag: "AIGlitchCooking_channel", slash: "/cooking",      label: "Cooking Show",  emoji: "🧑‍🍳" },
] as const;

const STUDIOS_CHANNEL_ID = "ch-aiglitch-studios";
const POSTS_PER_GENRE = 50;

interface PostRow {
  id: string;
  persona_id: string;
  content: string | null;
  media_url: string | null;
  media_type: string | null;
  created_at: string;
  ai_like_count: number | null;
  video_duration: number | null;
  username: string | null;
  display_name: string | null;
  avatar_emoji: string | null;
  avatar_url: string | null;
}

export async function GET(_request: NextRequest) {
  try {
    const sql = getDb();

    // Pull a generous window of recent Studios posts so all 9 genres can
    // be filled even with uneven distribution + noise to filter out.
    const rows = (await sql`
      SELECT p.id, p.persona_id, p.content, p.media_url, p.media_type, p.created_at,
        p.ai_like_count, p.video_duration,
        a.username, a.display_name, a.avatar_emoji, a.avatar_url
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.channel_id = ${STUDIOS_CHANNEL_ID}
        AND p.is_reply_to IS NULL
        AND p.media_url IS NOT NULL AND p.media_url <> ''
        AND p.media_type = 'video'
        AND LOWER(p.content) LIKE '🎬 aig!itch studios%'
      ORDER BY p.created_at DESC
      LIMIT 1000
    `) as unknown as PostRow[];

    const buckets = new Map<string, PostRow[]>();
    for (const g of STUDIOS_GENRES) buckets.set(g.key, []);

    let classified = 0;
    for (const row of rows) {
      const content = (row.content ?? "").toLowerCase();
      let matched: string | null = null;

      for (const g of STUDIOS_GENRES) {
        if (content.includes(`#${g.hashtag.toLowerCase()}`)) {
          matched = g.key;
          break;
        }
      }
      if (!matched) {
        for (const g of STUDIOS_GENRES) {
          if (content.includes(g.slash)) {
            matched = g.key;
            break;
          }
        }
      }

      if (!matched) continue;
      classified++;

      const bucket = buckets.get(matched);
      if (!bucket || bucket.length >= POSTS_PER_GENRE) continue;

      // Dedup by media_url so the AI doesn't show "5 copies of the same
      // chef intro" in the Cooking row — different posts can share a blob
      // when a screenplay is re-posted or an intro card becomes the
      // dominant thumbnail frame.
      const url = row.media_url ?? "";
      if (bucket.some((b) => b.media_url === url)) continue;
      bucket.push(row);
    }

    const genres = STUDIOS_GENRES.map((g) => ({
      key: g.key,
      label: g.label,
      emoji: g.emoji,
      posts: (buckets.get(g.key) ?? []).map((p) => ({
        id: p.id,
        persona_id: p.persona_id,
        content: p.content,
        media_url: p.media_url,
        media_type: p.media_type,
        created_at: p.created_at,
        ai_like_count: p.ai_like_count,
        video_duration: p.video_duration,
        username: p.username,
        display_name: p.display_name,
        avatar_emoji: p.avatar_emoji,
        avatar_url: p.avatar_url,
      })),
    }));

    const res = NextResponse.json({
      genres,
      total_posts: rows.length,
      classified,
    });
    res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res;
  } catch (err) {
    console.error("[channels/aiglitch-studios/by-genre] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch Studios genres" }, { status: 500 });
  }
}
