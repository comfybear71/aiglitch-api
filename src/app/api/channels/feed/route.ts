import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getBatchReactions } from "@/lib/repositories/interactions";
import {
  getAiComments,
  getBookmarkedSet,
  getHumanComments,
  getLikedSet,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const STUDIOS_CHANNEL_ID = "ch-aiglitch-studios";

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

interface ChannelPostRow {
  id: string;
  persona_id: string;
  content: string;
  post_type: string;
  media_url: string | null;
  media_type: string | null;
  media_source: string | null;
  hashtags: string | null;
  like_count: number;
  ai_like_count: number;
  comment_count: number;
  share_count: number;
  created_at: string;
  channel_id: string | null;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  persona_type: string;
  persona_bio: string;
  [key: string]: unknown;
}

/**
 * GET /api/channels/feed?slug=X[&limit=&cursor=&session_id=&shuffle=1&seed=&offset=]
 *
 * Channel-specific TV-style feed. Only returns posts explicitly tagged
 * with this channel's `channel_id` (no bleed from shared personas).
 * All channels require video media — images/memes don't appear in the
 * TV UI.
 *
 * Two special rules:
 *   - `ch-aiglitch-studios` lets director-scene sources through (their
 *     content IS the channel).
 *   - Other channels exclude `director-premiere/profile/scene` sources.
 *   - Channels with `genre='music_video'` require video too (same as
 *     the default rule today, but preserved as a separate branch for
 *     future divergence).
 *
 * Mode dispatch:
 *   - `?shuffle=1` with optional `?seed=` + `?offset=` — deterministic
 *     random via `md5(id::text || seed)`. Paginated by offset.
 *   - `?cursor=<iso-ts>` — chronological DESC, rows older than cursor.
 *   - default — chronological DESC from newest.
 *
 * Enrichment: comments (threaded AI + human), bookmarked flag, liked
 * flag (B-series fix pattern), emoji reaction counts + session's own
 * emoji reactions, per-post `socialLinks` from `marketing_posts`, plus
 * a top-level `subscribed` flag and the channel's persona roster.
 */
export async function GET(request: NextRequest) {
  try {
    const sql = getDb();

    const params = request.nextUrl.searchParams;
    const slug = params.get("slug");
    if (!slug) {
      return NextResponse.json({ error: "slug is required" }, { status: 400 });
    }

    const limit = Math.min(
      parseInt(params.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const cursor = params.get("cursor");
    const sessionId = params.get("session_id");
    const shuffle = params.get("shuffle") === "1";
    const seed = params.get("seed") ?? "0";
    const offset = parseInt(params.get("offset") ?? "0", 10) || 0;

    const [channel] = (await sql`
      SELECT id, name, slug, emoji, description, content_rules, schedule, subscriber_count, genre
      FROM channels WHERE slug = ${slug} AND is_active = TRUE
    `) as unknown as ChannelRow[];

    if (!channel) {
      return NextResponse.json(
        { error: "Channel not found" },
        { status: 404 },
      );
    }

    const channelId = channel.id;
    const isStudios = channelId === STUDIOS_CHANNEL_ID;

    let posts: ChannelPostRow[];
    if (shuffle) {
      posts = (await (isStudios
        ? sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
          ORDER BY md5(p.id::text || ${seed})
          LIMIT ${limit}
          OFFSET ${offset}
        `
        : sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY md5(p.id::text || ${seed})
          LIMIT ${limit}
          OFFSET ${offset}
        `)) as unknown as ChannelPostRow[];
    } else if (cursor) {
      posts = (await (isStudios
        ? sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor} AND p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
        : sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.created_at < ${cursor} AND p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `)) as unknown as ChannelPostRow[];
    } else {
      posts = (await (isStudios
        ? sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `
        : sql`
          SELECT p.*, a.username, a.display_name, a.avatar_emoji, a.avatar_url, a.persona_type, a.bio as persona_bio
          FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
            AND p.channel_id = ${channelId}
            AND p.media_url IS NOT NULL AND p.media_url != ''
            AND p.media_type = 'video'
            AND COALESCE(p.media_source, '') NOT IN ('director-premiere', 'director-profile', 'director-scene')
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `)) as unknown as ChannelPostRow[];
    }

    const channelShaped = {
      ...channel,
      content_rules:
        typeof channel.content_rules === "string"
          ? safeJson(channel.content_rules)
          : channel.content_rules,
      schedule:
        typeof channel.schedule === "string"
          ? safeJson(channel.schedule)
          : channel.schedule,
    };

    if (posts.length === 0) {
      // Still fetch subscription state + personas roster so the UI can
      // render the channel header even when the post list is empty.
      const [subResult, personasResult] = await subscriptionAndPersonas(
        sql,
        channelId,
        sessionId,
      );
      const res = NextResponse.json({
        channel: { ...channelShaped, subscribed: subResult.length > 0 },
        personas: personasResult,
        posts: [],
        nextCursor: null,
        nextOffset: null,
      });
      res.headers.set(
        "Cache-Control",
        "public, s-maxage=30, stale-while-revalidate=120",
      );
      return res;
    }

    const postIds = posts.map((p) => p.id);

    const [
      aiComments,
      humanComments,
      bookmarkedSet,
      likedSet,
      batchReactions,
      socialLinksRows,
    ] = await Promise.all([
      getAiComments(postIds),
      getHumanComments(postIds),
      sessionId ? getBookmarkedSet(postIds, sessionId) : Promise.resolve(new Set<string>()),
      sessionId ? getLikedSet(postIds, sessionId) : Promise.resolve(new Set<string>()),
      getBatchReactions(postIds, sessionId ?? undefined),
      sql`
        SELECT source_post_id, platform, platform_url FROM marketing_posts
        WHERE source_post_id = ANY(${postIds})
          AND status = 'posted'
          AND platform_url IS NOT NULL AND platform_url != ''
      `.catch(() => [] as unknown[]),
    ]);

    const socialLinks: Record<string, Record<string, string>> = {};
    for (const row of socialLinksRows as Array<{
      source_post_id: string;
      platform: string;
      platform_url: string;
    }>) {
      if (!socialLinks[row.source_post_id]) socialLinks[row.source_post_id] = {};
      socialLinks[row.source_post_id]![row.platform] = row.platform_url;
    }

    const commentsByPost = threadComments(aiComments, humanComments);

    const postsWithEnrichment = posts.map((post) => {
      const reactions = batchReactions[post.id];
      return {
        ...post,
        comments: commentsByPost.get(post.id) ?? [],
        bookmarked: bookmarkedSet.has(post.id),
        liked: likedSet.has(post.id),
        reactionCounts: reactions?.counts ?? {
          funny: 0,
          sad: 0,
          shocked: 0,
          crap: 0,
        },
        userReactions: reactions?.userReactions ?? [],
        socialLinks: socialLinks[post.id] ?? {},
      };
    });

    const nextCursor =
      !shuffle && posts.length === limit
        ? (posts[posts.length - 1]?.created_at ?? null)
        : null;
    const nextOffset =
      shuffle && posts.length === limit ? offset + limit : null;

    const [subResult, personasResult] = await subscriptionAndPersonas(
      sql,
      channelId,
      sessionId,
    );

    const res = NextResponse.json({
      channel: { ...channelShaped, subscribed: subResult.length > 0 },
      personas: personasResult,
      posts: postsWithEnrichment,
      nextCursor,
      nextOffset,
    });
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=120",
    );
    return res;
  } catch (err) {
    console.error("[channels/feed] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch channel feed" },
      { status: 500 },
    );
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type Sql = ReturnType<typeof getDb>;

async function subscriptionAndPersonas(
  sql: Sql,
  channelId: string,
  sessionId: string | null,
): Promise<[Array<{ id: string }>, unknown[]]> {
  const [subs, personas] = await Promise.all([
    sessionId
      ? sql`
          SELECT id FROM channel_subscriptions
          WHERE channel_id = ${channelId} AND session_id = ${sessionId}
        `
      : Promise.resolve([] as unknown[]),
    sql`
      SELECT cp.role, a.id as persona_id, a.username, a.display_name, a.avatar_emoji, a.avatar_url
      FROM channel_personas cp
      JOIN ai_personas a ON cp.persona_id = a.id
      WHERE cp.channel_id = ${channelId}
      ORDER BY cp.role ASC, a.follower_count DESC
    `,
  ]);
  return [subs as unknown as Array<{ id: string }>, personas as unknown[]];
}
