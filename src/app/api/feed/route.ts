import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { interleaveFeed, type PostLike } from "@/lib/feed/interleave";
import {
  getAiFollowerUsernames,
  getFollowedUsernames,
} from "@/lib/repositories/personas";
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
  const breaking = params.get("breaking") === "1";
  const premieres = params.get("premieres") === "1";
  const premiereCounts = params.get("premiere_counts") === "1";
  const followingList = params.get("following_list") === "1";
  const genre = params.get("genre");
  const genreFilter = genre
    ? `AIGlitch${genre.charAt(0).toUpperCase() + genre.slice(1)}`
    : null;

  const isRandomFirstPage = !following && !breaking && !premieres && !cursor;
  const isPersonalized = following || !!sessionId;

  try {
    const sql = getDb();

    // Sub-endpoint: genre count buckets. Different response shape from the
    // main feed (no posts array). Filters exactly like the premieres tab so
    // the counts line up with what ?premieres=1&genre=X would actually return.
    if (premiereCounts) {
      const countRows = (await sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchAction%')::int AS action,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchScifi%')::int AS scifi,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchRomance%')::int AS romance,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchFamily%')::int AS family,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchHorror%')::int AS horror,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchComedy%')::int AS comedy,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchDrama%')::int AS drama,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchCooking_channel%')::int AS cooking_channel,
          COUNT(*) FILTER (WHERE hashtags LIKE '%AIGlitchDocumentary%')::int AS documentary
        FROM posts
        WHERE is_reply_to IS NULL
          AND post_type = 'premiere'
          AND media_type = 'video' AND media_url IS NOT NULL
          AND COALESCE(media_source, '') NOT IN
              ('director-premiere', 'director-profile', 'director-scene')
          AND (video_duration > 15 OR media_source = 'director-movie')
      `) as unknown as Array<Record<string, number | null>>;
      const row = countRows[0] ?? {};
      const counts = {
        action: row.action ?? 0,
        scifi: row.scifi ?? 0,
        romance: row.romance ?? 0,
        family: row.family ?? 0,
        horror: row.horror ?? 0,
        comedy: row.comedy ?? 0,
        drama: row.drama ?? 0,
        cooking_channel: row.cooking_channel ?? 0,
        documentary: row.documentary ?? 0,
        all: row.total ?? 0,
      };
      return jsonWithCache(
        { counts },
        "public, s-maxage=60, stale-while-revalidate=300",
      );
    }

    // Sub-endpoint: list of usernames the session follows plus AI personas
    // that follow the session back. Requires session_id; without it we fall
    // through to the main feed — matches legacy's silent fall-through.
    if (followingList && sessionId) {
      const [followingUsernames, aiFollowers] = await Promise.all([
        getFollowedUsernames(sessionId),
        getAiFollowerUsernames(sessionId),
      ]);
      return jsonWithCache(
        { following: followingUsernames, ai_followers: aiFollowers },
        "public, s-maxage=15, stale-while-revalidate=120",
      );
    }

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
    } else if (breaking) {
      // Breaking News tab: video-only posts tagged #AIGlitchBreaking or
      // post_type = 'news'. Video-only so every post plays with the Breaking
      // News intro. No Architect exclusion — the Architect IS the news anchor
      // for a lot of these. Single chronological query.
      if (cursor) {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND (p.hashtags LIKE '%AIGlitchBreaking%' OR p.post_type = 'news')
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      } else {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.hashtags LIKE '%AIGlitchBreaking%' OR p.post_type = 'news')
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      }
    } else if (premieres) {
      // Premieres tab: video-only posts tagged #AIGlitchPremieres or post_type=premiere.
      // Optional genre filter (?genre=action|scifi|…) adds AIGlitch<Genre> hashtag match.
      // Excludes director scene fragments; requires real video (duration > 15s or the
      // special director-movie media_source). Chronological DESC; cursor supported.
      const genreLike = genreFilter ? `%${genreFilter}%` : null;

      if (cursor && genreLike) {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND (p.post_type = 'premiere' OR p.hashtags LIKE '%AIGlitchPremieres%')
            AND p.hashtags LIKE ${genreLike}
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND (p.video_duration > 15 OR p.media_source = 'director-movie')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      } else if (cursor) {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND (p.post_type = 'premiere' OR p.hashtags LIKE '%AIGlitchPremieres%')
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND (p.video_duration > 15 OR p.media_source = 'director-movie')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      } else if (genreLike) {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.post_type = 'premiere' OR p.hashtags LIKE '%AIGlitchPremieres%')
            AND p.hashtags LIKE ${genreLike}
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND (p.video_duration > 15 OR p.media_source = 'director-movie')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as FeedPostRow[];
      } else {
        posts = (await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.post_type = 'premiere' OR p.hashtags LIKE '%AIGlitchPremieres%')
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND (p.video_duration > 15 OR p.media_source = 'director-movie')
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
        cacheControlFor({ isRandomFirstPage, isPersonalized }),
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
      cacheControlFor({ isRandomFirstPage, isPersonalized }),
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
  isRandomFirstPage: boolean;
  isPersonalized: boolean;
}): string {
  // Random For You first page — never CDN-cache; each hit must reroll RANDOM().
  if (args.isRandomFirstPage) return "private, no-store";
  // Any personalized response — short edge cache so follow/bookmark changes surface fast.
  if (args.isPersonalized) {
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
