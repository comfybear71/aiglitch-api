/**
 * Premiere-post backfill / retag admin tool.
 *
 * GET  — Lists every video currently in Vercel Blob under
 *   `news/`, `premiere/`, and each per-genre `premiere/*` folder.
 *   Each entry carries detected `postType` (`news` / `premiere`)
 *   and `genre` (from `detectGenreFromPath`, with `cooking_show →
 *   cooking_channel` mapping). Used by the admin UI as a dry-run
 *   "what can I backfill?" view.
 *
 * POST — Two modes:
 *   • `{videoUrl, type?, genre?}` — create ONE post from the given
 *     Blob URL. Defaults `type="premiere"` + `genre="action"`.
 *   • No body — bulk backfill:
 *       1. Re-tag any existing `premiere` posts that are missing a
 *          genre-specific hashtag (`AIGlitch<Genre>`). Genre inferred
 *          from `media_url` path.
 *       2. Scan all blob folders; for every video NOT already in
 *          `posts` table (by `media_url`), create the right post
 *          variant using a random active persona (from a 5-persona
 *          shuffle sample, so the feed doesn't get dominated by one
 *          persona).
 *
 * Routes stay simple DB + Blob — no AI calls.
 */

import { randomUUID } from "node:crypto";
import { list as listBlobs } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  capitalizeGenre,
  detectGenreFromPath,
  getAllBlobFolders,
  getGenreHashtag,
  GENRE_LABELS,
} from "@/lib/genres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const GENRE_TAGLINES: Record<string, string[]> = {
  action: ["Hold on tight.", "No mercy. No retreat.", "The machines remember everything."],
  scifi: ["The future is now.", "Beyond the stars.", "Reality is just a setting."],
  romance: ["Love finds a way.", "Two hearts, one algorithm.", "Some connections transcend code."],
  family: ["Adventure awaits.", "Together we glitch.", "The whole crew is here."],
  horror: ["Don't look away.", "The code sees you.", "Some bugs can't be fixed."],
  comedy: ["You can't make this up.", "Error 404: Serious not found.", "Buffering... just kidding."],
  drama: ["Every choice has consequences.", "The truth will surface.", "Nothing is as it seems."],
  cooking_channel: ["The kitchen is heating up.", "Taste the future.", "One dish to rule them all."],
  documentary: ["The untold story.", "See the world differently.", "Truth is stranger than fiction."],
};

const NEWS_HEADLINES = [
  "BREAKING: Sources confirm what we all suspected",
  "DEVELOPING: The situation is evolving rapidly",
  "ALERT: You won't believe what just happened",
  "URGENT: This changes everything",
  "EXCLUSIVE: Inside the story everyone's talking about",
];

const ALL_PREFIXES = ["news", "premiere", ...getAllBlobFolders()];

function detectTypeAndGenre(pathname: string): {
  postType: "news" | "premiere";
  genre: string | null;
} {
  const lower = pathname.toLowerCase();
  if (lower.startsWith("news/") || lower.startsWith("news-")) {
    return { postType: "news", genre: null };
  }
  const detected = detectGenreFromPath(pathname);
  if (detected) return { postType: "premiere", genre: detected };
  if (lower.startsWith("premiere")) {
    return { postType: "premiere", genre: "action" };
  }
  return { postType: "premiere", genre: null };
}

type PersonaRow = { id: string; username: string };

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }

  const allVideos: {
    url: string;
    pathname: string;
    size: number;
    uploadedAt: Date;
    detectedType: string;
    detectedGenre: string | null;
  }[] = [];

  for (const prefix of ALL_PREFIXES) {
    try {
      let cursor: string | undefined;
      do {
        const result = await listBlobs({
          prefix,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const blob of result.blobs) {
          if (/\.(mp4|mov|webm|avi)$/i.test(blob.pathname)) {
            const { postType, genre } = detectTypeAndGenre(blob.pathname);
            allVideos.push({
              url: blob.url,
              pathname: blob.pathname,
              size: blob.size,
              uploadedAt: blob.uploadedAt,
              detectedType: postType,
              detectedGenre: genre,
            });
          }
        }
        cursor = result.hasMore ? result.cursor : undefined;
      } while (cursor);
    } catch {
      // Missing prefix is fine — continue scanning the others.
    }
  }

  const seen = new Set<string>();
  const unique = allVideos.filter((v) => {
    if (seen.has(v.url)) return false;
    seen.add(v.url);
    return true;
  });

  return NextResponse.json({
    videos: unique,
    count: unique.length,
    folders: ALL_PREFIXES,
    hint: "POST to create posts from blob videos. Pass { videoUrl, type, genre } or omit to auto-create from all unposted videos.",
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    videoUrl?: string;
    type?: "news" | "premiere";
    genre?: string;
  };

  const sql = getDb();
  const personas = (await sql`
    SELECT id, username FROM ai_personas WHERE is_active = TRUE ORDER BY RANDOM() LIMIT 5
  `) as unknown as PersonaRow[];

  if (personas.length === 0) {
    return NextResponse.json({ error: "No active personas found" }, { status: 500 });
  }

  if (body.videoUrl) {
    const postType = body.type ?? "premiere";
    const genre = body.genre ?? "action";
    const result = await createPost(sql, personas[0]!, body.videoUrl, postType, genre);
    return NextResponse.json(result);
  }

  const untagged = (await sql`
    SELECT id, media_url, hashtags FROM posts
    WHERE is_reply_to IS NULL
      AND (post_type = 'premiere' OR hashtags LIKE '%AIGlitchPremieres%')
      AND media_type = 'video' AND media_url IS NOT NULL
      AND hashtags NOT LIKE '%AIGlitchAction%'
      AND hashtags NOT LIKE '%AIGlitchScifi%'
      AND hashtags NOT LIKE '%AIGlitchRomance%'
      AND hashtags NOT LIKE '%AIGlitchFamily%'
      AND hashtags NOT LIKE '%AIGlitchHorror%'
      AND hashtags NOT LIKE '%AIGlitchComedy%'
      AND hashtags NOT LIKE '%AIGlitchDrama%'
      AND hashtags NOT LIKE '%AIGlitchCooking_channel%'
      AND hashtags NOT LIKE '%AIGlitchDocumentary%'
    LIMIT 100
  `) as unknown as { id: string; media_url: string; hashtags: string | null }[];

  let retagged = 0;
  for (const post of untagged) {
    const detected = detectGenreFromPath(post.media_url ?? "");
    const genre = detected ?? "action";
    const genreTag = `AIGlitch${capitalizeGenre(genre)}`;
    const newHashtags = post.hashtags
      ? `${post.hashtags},${genreTag}`
      : `AIGlitchPremieres,${genreTag}`;
    await sql`UPDATE posts SET hashtags = ${newHashtags} WHERE id = ${post.id}`;
    retagged++;
  }

  const existingUrls = (await sql`
    SELECT media_url FROM posts WHERE media_url IS NOT NULL AND media_type = 'video'
  `) as unknown as { media_url: string }[];
  const postedUrls = new Set(existingUrls.map((r) => r.media_url));

  const results: {
    videoUrl: string;
    postType: string;
    genre: string | null;
    postId: string;
    persona: string;
  }[] = [];

  for (const prefix of ALL_PREFIXES) {
    try {
      let cursor: string | undefined;
      do {
        const page = await listBlobs({
          prefix,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const blob of page.blobs) {
          if (!/\.(mp4|mov|webm|avi)$/i.test(blob.pathname)) continue;
          if (postedUrls.has(blob.url)) continue;

          const { postType, genre } = detectTypeAndGenre(blob.pathname);
          const persona = personas[Math.floor(Math.random() * personas.length)]!;
          const result = await createPost(sql, persona, blob.url, postType, genre);
          if (result.success && result.postId) {
            results.push({
              videoUrl: blob.url,
              postType,
              genre,
              postId: result.postId,
              persona: persona.username,
            });
            postedUrls.add(blob.url);
          }
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    } catch {
      continue;
    }
  }

  return NextResponse.json({
    success: true,
    created: results.length,
    retagged,
    posts: results,
    message:
      results.length > 0 || retagged > 0
        ? `Created ${results.length} posts, re-tagged ${retagged} existing posts. Check Premieres tab!`
        : "No new unposted videos found in blob storage.",
  });
}

async function createPost(
  sql: ReturnType<typeof getDb>,
  persona: PersonaRow,
  videoUrl: string,
  postType: "news" | "premiere",
  genre: string | null,
): Promise<{ success: boolean; postId?: string; error?: string }> {
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 300) + 100;

  if (postType === "news") {
    const headline = NEWS_HEADLINES[Math.floor(Math.random() * NEWS_HEADLINES.length)];
    const content = `📰 ${headline}\n\nAIG!itch News Network brings you this developing story. Stay tuned for updates.\n\n#AIGlitchBreaking #AIGlitchNews`;
    await sql`
      INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, created_at)
      VALUES (${postId}, ${persona.id}, ${content}, 'news', 'AIGlitchBreaking,AIGlitchNews', ${aiLikeCount}, ${videoUrl}, 'video', 'grok-video', NOW())
    `;
  } else {
    const g = genre ?? "action";
    const label = GENRE_LABELS[g] ?? g;
    const taglines = GENRE_TAGLINES[g] ?? GENRE_TAGLINES.action!;
    const tagline = taglines[Math.floor(Math.random() * taglines.length)];
    const genreTag = getGenreHashtag(g);
    const content = `🎬 AIG!itch Studios Presents\n"${tagline}"\n\n🍿 A new ${label} premiere is HERE. This is the one you've been waiting for.\n\n#AIGlitchPremieres #${genreTag}`;
    const hashtags = `AIGlitchPremieres,${genreTag}`;
    await sql`
      INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, created_at)
      VALUES (${postId}, ${persona.id}, ${content}, 'premiere', ${hashtags}, ${aiLikeCount}, ${videoUrl}, 'video', 'grok-video', NOW())
    `;
  }

  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;
  return { success: true, postId };
}
