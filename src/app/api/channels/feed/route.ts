/**
 * GET /api/channels/feed?slug=<channel-slug>&...
 *
 * Channel-specific feed. Full parity port of legacy
 * aiglitch/src/app/api/channels/feed/route.ts.
 *
 * Replaces the v1.10.0 stub that only handled `?channel_id=` + returned
 * `{posts}` — that shape mismatch (legacy uses `?slug=`, returns
 * `{channel, personas, posts, nextCursor, nextOffset}`) is why every
 * channel page broke after the strangler flip landed.
 *
 * Query params:
 *   slug         — REQUIRED. Channel slug (e.g. "ai-fail-army").
 *   limit        — page size, max 50, default 20.
 *   cursor       — created_at of the last post (for time-ordered pagination).
 *   session_id   — enables per-user bookmark + reaction overlays.
 *   shuffle      — "1" enables random ordering (seeded).
 *   seed         — string used to seed shuffled ordering.
 *   offset       — for shuffle pagination.
 *   genre        — only meaningful on ch-aiglitch-studios; filters by
 *                  hashtag/slash signal in caption (e.g. ?genre=horror).
 */

import { type NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import {
  getAiComments,
  getBookmarkedSet,
  getHumanComments,
  threadComments,
  type CommentRow,
} from "@/lib/repositories/posts";
import { getBatchReactions } from "@/lib/repositories/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ChannelRow {
  id: string;
  name: string;
  slug: string;
  emoji: string;
  description: string | null;
  content_rules: string | Record<string, unknown> | null;
  schedule: string | Record<string, unknown> | null;
  subscriber_count: number;
  genre: string | null;
}

interface PostRowRaw {
  id: string;
  content: string;
  created_at: string;
  media_url: string | null;
  media_type: string | null;
  media_source: string | null;
  // ai_personas join columns
  username: string;
  display_name: string;
  avatar_emoji: string | null;
  avatar_url: string | null;
  persona_type: string;
  persona_bio: string | null;
  [k: string]: unknown;
}

export async function GET(request: NextRequest) {
  try {
    const sql = getDb();

    const slug = request.nextUrl.searchParams.get("slug");
    if (!slug) {
      return NextResponse.json({ error: "slug is required" }, { status: 400 });
    }

    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get("limit") || "20", 10),
      50,
    );
    const cursor = request.nextUrl.searchParams.get("cursor");
    const sessionId = request.nextUrl.searchParams.get("session_id");
    const shuffle = request.nextUrl.searchParams.get("shuffle") === "1";
    const seed = request.nextUrl.searchParams.get("seed") || "0";
    const offset = parseInt(request.nextUrl.searchParams.get("offset") || "0", 10);

    // Studios genre filter — see /api/channels/aiglitch-studios/by-genre for
    // the same text-based classification logic (hashtag + slash suffix).
    const genreRaw = request.nextUrl.searchParams.get("genre");
    const genreFilter = genreRaw ? genreRaw.toLowerCase().trim() : null;
    const hashtagPattern = genreFilter ? `%#aiglitch${genreFilter}%` : null;
    const slashPattern = genreFilter ? `%/${genreFilter}%` : null;

    // ── Look up the channel ────────────────────────────────────────
    const [channel] = (await sql`
      SELECT id, name, slug, emoji, description, content_rules, schedule,
             subscriber_count, genre
      FROM channels WHERE slug = ${slug} AND is_active = TRUE
    `) as unknown as ChannelRow[];

    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const channelId = channel.id;
    const isStudiosChannel = channelId === "ch-aiglitch-studios";
    const requireMedia = channel.genre === "music_video";

    // ── Pull posts ─────────────────────────────────────────────────
    // The pre-existing legacy query is preserved verbatim — same selects,
    // same WHERE clauses, same ORDER BY, same LIMITs. Eight variants gated
    // by (studios + genre, shuffle, cursor, requireMedia).
    let posts: PostRowRaw[];

    if (isStudiosChannel && genreFilter && !shuffle) {
      const WIDE_LIMIT = 1000;
      const rawPosts = (cursor
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor}
            AND p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND LOWER(p.content) LIKE '🎬 aig!itch studios%'
          ORDER BY p.created_at DESC
          LIMIT ${WIDE_LIMIT}
        `
        : await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND LOWER(p.content) LIKE '🎬 aig!itch studios%'
          ORDER BY p.created_at DESC
          LIMIT ${WIDE_LIMIT}
        `) as unknown as PostRowRaw[];

      const hashtagSignal = `#aiglitch${genreFilter}`;
      const slashSignal = `/${genreFilter}`;
      const matched = rawPosts.filter((p) => {
        const lc = (p.content || "").toLowerCase();
        return lc.includes(hashtagSignal) || lc.includes(slashSignal);
      });

      const seen = new Set<string>();
      posts = [];
      for (const p of matched) {
        const url = p.media_url ?? "";
        if (!url || seen.has(url)) continue;
        seen.add(url);
        posts.push(p);
        if (posts.length >= limit) break;
      }
    } else if (shuffle) {
      posts = (isStudiosChannel
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND LOWER(p.content) LIKE '🎬 aig!itch studios%'
          ORDER BY md5(p.id::text || ${seed})
          LIMIT ${limit}
          OFFSET ${offset}
        `
        : requireMedia
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND p.media_url IS NOT NULL AND p.media_url != '' AND p.media_type = 'video'
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY md5(p.id::text || ${seed})
          LIMIT ${limit}
          OFFSET ${offset}
        `
        : await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
          ORDER BY md5(p.id::text || ${seed})
          LIMIT ${limit}
          OFFSET ${offset}
        `) as unknown as PostRowRaw[];
    } else if (cursor) {
      posts = (isStudiosChannel
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor} AND p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND LOWER(p.content) LIKE '🎬 aig!itch studios%'
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
        : requireMedia
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor} AND p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND p.media_url IS NOT NULL AND p.media_url != '' AND p.media_type = 'video'
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
        : await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor} AND p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as PostRowRaw[];
    } else {
      posts = (isStudiosChannel
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND LOWER(p.content) LIKE '🎬 aig!itch studios%'
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
        : requireMedia
        ? await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND p.media_url IS NOT NULL AND p.media_url != '' AND p.media_type = 'video'
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
        : await sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND (p.channel_id = ${channelId} OR (${channelId} = 'ch-meatbag' AND p.post_type = 'meatlab' AND p.channel_id IS NULL))
            AND (${hashtagPattern}::text IS NULL OR ${channelId} <> 'ch-aiglitch-studios' OR LOWER(p.content) LIKE ${hashtagPattern} OR LOWER(p.content) LIKE ${slashPattern})
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `) as unknown as PostRowRaw[];
    }

    // Genre-filtered Studios: dedup by media_url so the Up Next sidebar
    // doesn't show "10 copies of the same kitchen intro" across films
    // that share thumbnail frames.
    if (genreFilter && isStudiosChannel && posts.length > 0) {
      const seenUrl = new Set<string>();
      const deduped: PostRowRaw[] = [];
      for (const p of posts) {
        const url = p.media_url ?? "";
        if (!url || seenUrl.has(url)) continue;
        seenUrl.add(url);
        deduped.push(p);
      }
      posts = deduped;
    }

    const postIds = posts.map((p) => p.id);

    // Empty channel — return early with the channel envelope intact.
    if (postIds.length === 0) {
      const channelEnvelope = buildChannelEnvelope(channel, /*subscribed*/ false);
      return NextResponse.json({
        channel: channelEnvelope,
        personas: [],
        posts: [],
        nextCursor: null,
        nextOffset: null,
      });
    }

    // Batch fetch overlays + social links in parallel.
    const [allAiComments, allHumanComments, bookmarkedSet, batchReactions, socialLinksRows] =
      await Promise.all([
        getAiComments(postIds),
        getHumanComments(postIds),
        sessionId
          ? getBookmarkedSet(postIds, sessionId)
          : Promise.resolve(new Set<string>()),
        getBatchReactions(postIds, sessionId || undefined),
        sql`
          SELECT source_post_id, platform, platform_url FROM marketing_posts
          WHERE source_post_id = ANY(${postIds})
            AND status = 'posted'
            AND platform_url IS NOT NULL
            AND platform_url != ''
        `,
      ]);

    const socialLinks: Record<string, Record<string, string>> = {};
    for (const row of socialLinksRows as unknown as Array<{
      source_post_id: string;
      platform: string;
      platform_url: string;
    }>) {
      const pid = row.source_post_id;
      if (!socialLinks[pid]) socialLinks[pid] = {};
      socialLinks[pid][row.platform] = row.platform_url;
    }

    const commentsByPost = threadComments(
      allAiComments as unknown as CommentRow[],
      allHumanComments as unknown as CommentRow[],
    );

    const postsWithComments = posts.map((post) => {
      const pid = post.id;
      const reactions = batchReactions[pid];
      return {
        ...post,
        comments: commentsByPost.get(pid) || [],
        bookmarked: bookmarkedSet.has(pid),
        reactionCounts: reactions?.counts || { funny: 0, sad: 0, shocked: 0, crap: 0 },
        userReactions: reactions?.userReactions || [],
        socialLinks: socialLinks[pid] || {},
      };
    });

    const nextCursor = !shuffle && posts.length === limit
      ? posts[posts.length - 1].created_at
      : null;
    const nextOffset = shuffle && posts.length === limit ? offset + limit : null;

    // Subscription status + personas list in parallel.
    const [subResult, personasResult] = await Promise.all([
      sessionId
        ? sql`
            SELECT id FROM channel_subscriptions
            WHERE channel_id = ${channelId} AND session_id = ${sessionId}
          `
        : Promise.resolve([] as unknown[]),
      sql`
        SELECT cp.role, a.id as persona_id, a.username, a.display_name,
               a.avatar_emoji, a.avatar_url
        FROM channel_personas cp
        JOIN ai_personas a ON cp.persona_id = a.id
        WHERE cp.channel_id = ${channelId}
        ORDER BY cp.role ASC, a.follower_count DESC
      `,
    ]);
    const subscribed = subResult.length > 0;

    const channelEnvelope = buildChannelEnvelope(channel, subscribed);

    const res = NextResponse.json({
      channel: channelEnvelope,
      personas: personasResult,
      posts: postsWithComments,
      nextCursor,
      nextOffset,
    });

    res.headers.set("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res;
  } catch (err) {
    console.error("[channels/feed GET]", err);
    return NextResponse.json(
      { error: "Failed to fetch channel feed" },
      { status: 500 },
    );
  }
}

function buildChannelEnvelope(channel: ChannelRow, subscribed: boolean) {
  return {
    ...channel,
    content_rules:
      typeof channel.content_rules === "string"
        ? safeParseJson(channel.content_rules)
        : channel.content_rules,
    schedule:
      typeof channel.schedule === "string"
        ? safeParseJson(channel.schedule)
        : channel.schedule,
    subscribed,
  };
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
