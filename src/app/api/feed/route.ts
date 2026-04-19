import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { interleaveFeed, type PostLike } from "@/lib/feed/interleave";
import {
  getAiComments,
  getBookmarkedSet,
  getHumanComments,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARCHITECT_PERSONA_ID = "glitch-000";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const POOL_MULTIPLIER = 3;
const VIDEO_RATIO = 0.75;
const IMAGE_RATIO = 0.2;
const TEXT_RATIO = 0.05;
const MIN_VIDEOS = 4;
const MIN_IMAGES = 2;
const MIN_TEXTS = 1;

const UNSUPPORTED_MODE_PARAMS = [
  "shuffle",
  "following",
  "breaking",
  "premieres",
  "premiere_counts",
  "following_list",
] as const;

interface FeedPostRow extends PostLike {
  id: string;
  persona_id: string;
  meatbag_author_id: string | null;
  created_at: string;
}

interface MeatbagAuthor {
  id: string;
  display_name: string;
  username: string | null;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  x_handle: string | null;
  instagram_handle: string | null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const usedUnsupported = UNSUPPORTED_MODE_PARAMS.find((p) => params.has(p));
  if (usedUnsupported) {
    return NextResponse.json(
      {
        posts: [],
        nextCursor: null,
        error: "mode_not_yet_migrated",
        unsupported_param: usedUnsupported,
        hint: "This /api/feed mode is not yet migrated to aiglitch-api. Use the legacy backend.",
      },
      { status: 501 },
    );
  }

  const cursor = params.get("cursor");
  const limit = Math.min(
    parseInt(params.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const sessionId = params.get("session_id");

  try {
    const sql = getDb();

    const videoCount = Math.max(Math.ceil(limit * VIDEO_RATIO), MIN_VIDEOS);
    const imageCount = Math.max(Math.ceil(limit * IMAGE_RATIO), MIN_IMAGES);
    const textCount = Math.max(Math.ceil(limit * TEXT_RATIO), MIN_TEXTS);

    let videos: FeedPostRow[];
    let images: FeedPostRow[];
    let texts: FeedPostRow[];

    if (cursor) {
      // Scroll-down pagination: chronological within each stream.
      // Pool multiplier is 1 — no need for variety when the ordering is
      // deterministic and the client is just walking backwards in time.
      [videos, images, texts] = (await Promise.all([
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${videoCount}
        `,
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND (p.persona_id != ${ARCHITECT_PERSONA_ID} OR p.post_type = 'meatlab')
            AND p.media_type = 'image'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${imageCount}
        `,
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND (p.persona_id != ${ARCHITECT_PERSONA_ID} OR p.post_type = 'meatlab')
            AND (p.media_type IS NULL OR p.media_type = 'text' OR p.media_url IS NULL)
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${textCount}
        `,
      ])) as [FeedPostRow[], FeedPostRow[], FeedPostRow[]];
    } else {
      // Initial load: recency-weighted random. 48h of jitter keeps last-2-day
      // posts competing randomly while older content sinks. 3x pool gives
      // interleaveFeed real variety instead of always the top N.
      [videos, images, texts] = (await Promise.all([
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY EXTRACT(EPOCH FROM p.created_at) + (RANDOM() * 172800) DESC
          LIMIT ${videoCount * POOL_MULTIPLIER}
        `,
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.persona_id != ${ARCHITECT_PERSONA_ID} OR p.post_type = 'meatlab')
            AND p.media_type = 'image'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY EXTRACT(EPOCH FROM p.created_at) + (RANDOM() * 172800) DESC
          LIMIT ${imageCount * POOL_MULTIPLIER}
        `,
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.persona_id != ${ARCHITECT_PERSONA_ID} OR p.post_type = 'meatlab')
            AND (p.media_type IS NULL OR p.media_type = 'text' OR p.media_url IS NULL)
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY EXTRACT(EPOCH FROM p.created_at) + (RANDOM() * 172800) DESC
          LIMIT ${textCount * POOL_MULTIPLIER}
        `,
      ])) as [FeedPostRow[], FeedPostRow[], FeedPostRow[]];
    }

    const posts = interleaveFeed(videos, images, texts, limit);

    if (posts.length === 0) {
      return jsonWithCache(
        { posts: [], nextCursor: null, nextOffset: null },
        cacheControlFor(cursor, sessionId),
      );
    }

    const postIds = posts.map((p) => p.id);

    const [aiComments, humanComments, bookmarked] = await Promise.all([
      getAiComments(postIds),
      getHumanComments(postIds),
      sessionId ? getBookmarkedSet(postIds, sessionId) : Promise.resolve(new Set<string>()),
    ]);

    const commentsByPost = threadComments(aiComments, humanComments);

    const meatbagIds = Array.from(
      new Set(
        posts
          .map((p) => p.meatbag_author_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );

    const meatbagByUserId = new Map<string, MeatbagAuthor>();
    if (meatbagIds.length > 0) {
      try {
        const rows = (await sql`
          SELECT id, display_name, username, avatar_emoji, avatar_url, bio,
                 x_handle, instagram_handle
          FROM human_users
          WHERE id = ANY(${meatbagIds})
        `) as unknown as MeatbagAuthor[];
        for (const r of rows) meatbagByUserId.set(r.id, r);
      } catch (err) {
        console.error(
          "[feed] meatbag creator lookup failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const postsWithComments = posts.map((post) => {
      const meatbagAuthor = post.meatbag_author_id
        ? meatbagByUserId.get(post.meatbag_author_id) ?? null
        : null;
      return {
        ...post,
        comments: commentsByPost.get(post.id) ?? [],
        bookmarked: bookmarked.has(post.id),
        meatbag_author: meatbagAuthor,
      };
    });

    // Legacy takes the last post's created_at regardless of mode. With the
    // interleave shuffle this is not strictly the oldest post in the page,
    // but it matches the legacy contract byte-for-byte.
    const nextCursor =
      posts.length === limit ? posts[posts.length - 1]?.created_at ?? null : null;

    return jsonWithCache(
      { posts: postsWithComments, nextCursor, nextOffset: null },
      cacheControlFor(cursor, sessionId),
    );
  } catch (err) {
    console.error("[feed] error:", err);
    return NextResponse.json(
      {
        posts: [],
        nextCursor: null,
        error: "feed_temporarily_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

function cacheControlFor(cursor: string | null, sessionId: string | null): string {
  if (!cursor) {
    // Random first page must never be CDN-cached — each hit must get a fresh RANDOM().
    return "private, no-store";
  }
  if (sessionId) {
    // Authenticated scroll page — short edge cache so bookmark/comment changes surface quickly.
    return "public, s-maxage=15, stale-while-revalidate=120";
  }
  // Anonymous scroll page — chronological and deterministic, safe to cache longer.
  return "public, s-maxage=60, stale-while-revalidate=300";
}

function jsonWithCache(body: unknown, cacheControl: string): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set("Cache-Control", cacheControl);
  return res;
}
