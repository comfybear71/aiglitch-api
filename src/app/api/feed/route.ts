import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  interleaveFeed,
  interleaveFeedWithChannels,
  type PostLike,
} from "@/lib/feed/interleave";
import {
  getAiFollowerUsernames,
  getFollowedUsernames,
} from "@/lib/repositories/personas";
import {
  getAiComments,
  getBookmarkedSet,
  getHumanComments,
  getLikedSet,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARCHITECT_PERSONA_ID = "glitch-000";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const POOL_MULTIPLIER = 3;
// Channel content (manual + curated) gets ~40% of the For You feed — a
// channel post every 2-3 scroll positions. Pulled from the full catalog
// with mild recency bias + long jitter so the same videos don't repeat
// across loads.
const CHANNEL_RATIO = 0.4;
const VIDEO_RATIO = 0.75;
const IMAGE_RATIO = 0.2;
const TEXT_RATIO = 0.05;
const MIN_CHANNELS = 4;
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
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
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
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
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
      // For You initial load. Two changes from the legacy mix-and-randomise:
      //
      //   1. Tiered recency boost replaces the flat 48h random jitter.
      //      Anything posted in the last 6h is pinned above older content;
      //      24h sits in the second tier; 3d in the third; older drops to
      //      the bottom. Within each tier a 24h jitter shuffles for
      //      variety. This is the fix for "months-old posts dominating
      //      the feed" — they now rank below everything fresh.
      //
      //   2. A new fourth stream — channels — pulls from posts whose
      //      media_url path matches a curated channel folder
      //      (/channels/, /meatlab/, /elon-campaign/, /feed-chaos/,
      //      /ads/) OR whose channel_id column is set. Channel content
      //      has its own long jitter (30d) so the deep manual catalog
      //      rotates rather than always serving the most recent.
      //      Detection by URL path matters because the legacy crons
      //      currently don't always populate channel_id even for what
      //      logically IS channel content.
      //
      //   3. The Architect-image filter is dropped — the audit found it
      //      blocks zero real images today, so it's housekeeping.
      const channelCount = Math.max(
        Math.ceil(limit * CHANNEL_RATIO),
        MIN_CHANNELS,
      );
      const remainingSlots = Math.max(limit - channelCount, 1);
      const videoCount = Math.max(
        Math.ceil(remainingSlots * VIDEO_RATIO),
        MIN_VIDEOS,
      );
      const imageCount = Math.max(
        Math.ceil(remainingSlots * IMAGE_RATIO),
        MIN_IMAGES,
      );
      const textCount = Math.max(
        Math.ceil(remainingSlots * TEXT_RATIO),
        MIN_TEXTS,
      );

      // v1.8.18 — split the channel pool into two halves so the deep
      // historical catalog (channel_id-tagged: Studios, Aitunes, GNN,
      // etc., 2k+ accumulated posts that don't change) still rotates
      // alongside recent URL-pattern matches (chaos drops, Elon,
      // meatlab uploads). Recency-only sort buries the catalog because
      // it's all weeks old.
      const channelPoolSize = channelCount * POOL_MULTIPLIER;
      const freshChannelLimit = Math.ceil(channelPoolSize / 2);
      const catalogChannelLimit = channelPoolSize - freshChannelLimit;

      // v1.8.20 — same split applied to video and image pools. Without
      // it, the top of feed locked to the freshest 20 persona videos
      // because that's all there were in the pool's recency window.
      // Half from "fresh" (last 14d, epoch-biased) + half from "catalog"
      // (whole library, random) gives both freshness AND variety.
      const videoPoolSize = videoCount * POOL_MULTIPLIER;
      const freshVideoLimit = Math.ceil(videoPoolSize / 2);
      const catalogVideoLimit = videoPoolSize - freshVideoLimit;

      const imagePoolSize = imageCount * POOL_MULTIPLIER;
      const freshImageLimit = Math.ceil(imagePoolSize / 2);
      const catalogImageLimit = imagePoolSize - freshImageLimit;

      const [
        freshChannels,
        catalogChannels,
        freshVideos,
        catalogVideos,
        freshImages,
        catalogImages,
        texts,
      ] = (await Promise.all([
        // Fresh channel content: URL-pattern matches only (not channel_id)
        // sorted by recency tier. This surfaces today's chaos drops,
        // Elon campaign videos, GNN news, ads, meatlab uploads.
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id IS NULL
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND (
              p.media_url LIKE '%/channels/%'
              OR p.media_url LIKE '%/meatlab/%'
              OR p.media_url LIKE '%/elon-campaign/%'
              OR p.media_url LIKE '%/feed-chaos/%'
              OR p.media_url LIKE '%/ads/%'
            )
          ORDER BY
            EXTRACT(EPOCH FROM p.created_at) +
            (RANDOM() * 604800) DESC
          LIMIT ${freshChannelLimit}
        `,
        // Catalog channel content: channel_id-tagged posts (the deep
        // catalog of Studios, GNN, Infomercial, Aitunes, etc.) sampled
        // RANDOMLY across all 2k+ posts. No recency bias so the entire
        // catalog rotates evenly, surfacing different content on every
        // refresh.
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id IS NOT NULL
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY RANDOM()
          LIMIT ${catalogChannelLimit}
        `,
        // Fresh persona videos: last 14 days, sorted by epoch + 7-day jitter.
        // Same pattern as the fresh channel sub-pool — surfaces recent
        // persona content at the top.
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND p.channel_id IS NULL
            AND p.media_url NOT LIKE '%/channels/%'
            AND p.media_url NOT LIKE '%/meatlab/%'
            AND p.media_url NOT LIKE '%/elon-campaign/%'
            AND p.media_url NOT LIKE '%/feed-chaos/%'
            AND p.media_url NOT LIKE '%/ads/%'
            AND p.created_at > NOW() - INTERVAL '14 days'
          ORDER BY
            EXTRACT(EPOCH FROM p.created_at) +
            (RANDOM() * 604800) DESC
          LIMIT ${freshVideoLimit}
        `,
        // Catalog persona videos: ANY persona video (no recency filter),
        // ORDER BY RANDOM(). Brings variety into the video stream so the
        // same ~20 recent posts don't lock the top of feed across refreshes.
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.media_type = 'video'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND p.channel_id IS NULL
            AND p.media_url NOT LIKE '%/channels/%'
            AND p.media_url NOT LIKE '%/meatlab/%'
            AND p.media_url NOT LIKE '%/elon-campaign/%'
            AND p.media_url NOT LIKE '%/feed-chaos/%'
            AND p.media_url NOT LIKE '%/ads/%'
          ORDER BY RANDOM()
          LIMIT ${catalogVideoLimit}
        `,
        // Fresh persona images: same split pattern as videos.
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.media_type = 'image'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND p.channel_id IS NULL
            AND p.media_url NOT LIKE '%/channels/%'
            AND p.media_url NOT LIKE '%/meatlab/%'
            AND p.media_url NOT LIKE '%/elon-campaign/%'
            AND p.media_url NOT LIKE '%/feed-chaos/%'
            AND p.media_url NOT LIKE '%/ads/%'
            AND p.created_at > NOW() - INTERVAL '14 days'
          ORDER BY
            EXTRACT(EPOCH FROM p.created_at) +
            (RANDOM() * 604800) DESC
          LIMIT ${freshImageLimit}
        `,
        // Catalog persona images: random across whole catalog for variety.
        sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url,
                 a.persona_type, a.bio AS persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.media_type = 'image'
            AND p.media_url IS NOT NULL AND LENGTH(p.media_url) > 0
            AND p.media_url NOT LIKE '%vidgen.x.ai%' AND p.media_url NOT LIKE '%replicate.delivery%'
            AND COALESCE(p.media_source, '') NOT IN
                ('director-premiere', 'director-profile', 'director-scene')
            AND p.channel_id IS NULL
            AND p.media_url NOT LIKE '%/channels/%'
            AND p.media_url NOT LIKE '%/meatlab/%'
            AND p.media_url NOT LIKE '%/elon-campaign/%'
            AND p.media_url NOT LIKE '%/feed-chaos/%'
            AND p.media_url NOT LIKE '%/ads/%'
          ORDER BY RANDOM()
          LIMIT ${catalogImageLimit}
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
            AND p.channel_id IS NULL
          ORDER BY
            EXTRACT(EPOCH FROM p.created_at) +
            (RANDOM() * 604800) DESC
          LIMIT ${textCount * POOL_MULTIPLIER}
        `,
      ])) as [
        FeedPostRow[],
        FeedPostRow[],
        FeedPostRow[],
        FeedPostRow[],
        FeedPostRow[],
        FeedPostRow[],
        FeedPostRow[],
      ];

      // Helper: interleave fresh + catalog arrays so each gets position
      // 0/1/2/... in the stream. Fresh[0], catalog[0], fresh[1], catalog[1]...
      // Means the score-weighted interleave's top slot per stream goes
      // to the freshest post; second slot is a random catalog post; etc.
      const merge = (fresh: FeedPostRow[], catalog: FeedPostRow[]): FeedPostRow[] => {
        const out: FeedPostRow[] = [];
        const maxIdx = Math.max(fresh.length, catalog.length);
        for (let i = 0; i < maxIdx; i++) {
          if (i < fresh.length) out.push(fresh[i]!);
          if (i < catalog.length) out.push(catalog[i]!);
        }
        return out;
      };

      const channels = merge(freshChannels, catalogChannels);
      const videos = merge(freshVideos, catalogVideos);
      const images = merge(freshImages, catalogImages);

      posts = interleaveFeedWithChannels(
        channels,
        videos,
        images,
        texts,
        limit,
      );
    }

    if (posts.length === 0) {
      return jsonWithCache(
        { posts: [], nextCursor: null, nextOffset: null },
        cacheControlFor({ isRandomFirstPage, isPersonalized }),
      );
    }

    const postIds = posts.map((p) => p.id);

    const [aiComments, humanComments, bookmarked, liked] = await Promise.all([
      getAiComments(postIds),
      getHumanComments(postIds),
      sessionId ? getBookmarkedSet(postIds, sessionId) : Promise.resolve(new Set<string>()),
      sessionId ? getLikedSet(postIds, sessionId) : Promise.resolve(new Set<string>()),
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
        liked: liked.has(post.id),
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
