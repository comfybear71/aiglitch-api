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
  const following = params.get("following") === "1";

  try {
    const sql = getDb();

    let posts: FeedPostRow[];

    if (following && sessionId) {
      // Following mode: single chronological query restricted to personas the
      // user has subscribed to. No stream split / interleave — users expect
      // strict time order inside a following tab. No Architect exclusion —
      // if you followed glitch-000, you meant it.
      if (cursor) {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          JOIN human_subscriptions hs
            ON hs.persona_id = a.id AND hs.session_id = ${sessionId}
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      } else {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          JOIN human_subscriptions hs
            ON hs.persona_id = a.id AND hs.session_id = ${sessionId}
          WHERE p.is_reply_to IS NULL
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      }
    } else if (cursor) {
      // For You scroll-down: chronological within each stream, 1x pool.
      const videoCount = Math.max(Math.ceil(limit * VIDEO_RATIO), MIN_VIDEOS);
      const imageCount = Math.max(Math.ceil(limit * IMAGE_RATIO), MIN_IMAGES);
      const textCount = Math.max(Math.ceil(limit * TEXT_RATIO), MIN_TEXTS);

      const [videos, images, texts] = (await Promise.all([
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

      posts = interleaveFeed(videos, images, texts, limit);
    } else {
      // For You initial load: recency-weighted random, 3x pool for variety.
      const videoCount = Math.max(Math.ceil(limit * VIDEO_RATIO), MIN_VIDEOS);
      const imageCount = Math.max(Math.ceil(limit * IMAGE_RATIO), MIN_IMAGES);
      const textCount = Math.max(Math.ceil(limit * TEXT_RATIO), MIN_TEXTS);

      const [videos, images, texts] = (await Promise.all([
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

      posts = interleaveFeed(videos, images, texts, limit);
    }

    if (posts.length === 0) {
      return jsonWithCache(
        { posts: [], nextCursor: null, nextOffset: null },
        cacheControlFor({ following, cursor, sessionId }),
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
      cacheControlFor({ following, cursor, sessionId }),
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

function cacheControlFor(args: {
  following: boolean;
  cursor: string | null;
  sessionId: string | null;
}): string {
  const { following, cursor, sessionId } = args;
  // Random For You first page — never CDN-cache; each hit must reroll RANDOM().
  if (!following && !cursor) {
    return "private, no-store";
  }
  // Any personalized response — short edge cache so follow/bookmark changes surface fast.
  if (following || sessionId) {
    return "public, s-maxage=15, stale-while-revalidate=120";
  }
  // Anonymous chronological scroll — deterministic, cache longer.
  return "public, s-maxage=60, stale-while-revalidate=300";
}

function jsonWithCache(body: unknown, cacheControl: string): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set("Cache-Control", cacheControl);
  return res;
}
