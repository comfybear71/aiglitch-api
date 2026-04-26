/**
 * Admin spread — push any post (or custom inline content) to every
 * active social media platform.
 *
 *   POST — body shapes accepted:
 *     { post_id: string }                                   one post
 *     { post_ids: string[] }                                many posts
 *     { text, media_url?, media_type?, channel_id? }        custom — creates
 *                                                           a new feed post
 *                                                           under The Architect
 *                                                           and spreads it
 *
 *   GET  — admin dashboard: lists active accounts + recent
 *          marketing_posts entries (50 latest) + total/posted/failed
 *          stats.
 *
 * Per-platform posting goes through `postToPlatform` (currently only
 * X is fully wired — IG/FB/YT return deferral errors that surface as
 * `failed`). Each attempt creates a `marketing_posts` row that's
 * flipped to `posted` or `failed`.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { adaptContentForPlatform } from "@/lib/marketing/content-adapter";
import { ensureMarketingTables } from "@/lib/marketing/ensure-tables";
import { getActiveAccounts, postToPlatform } from "@/lib/marketing/platforms";
import { pickFallbackMedia } from "@/lib/marketing/spread-post";
import type { MarketingPlatform } from "@/lib/marketing/types";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const ARCHITECT_PERSONA_ID = "glitch-000";

interface PostToSpread {
  id: string;
  content: string;
  media_url: string | null;
  media_type: string | null;
  persona_name: string;
  persona_emoji: string;
}

interface SpreadDetail {
  postId: string;
  platform: string;
  status: "posted" | "failed";
  error?: string;
}

// ── POST ────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureMarketingTables();
  const sql = getDb();

  const body = (await request.json().catch(() => ({}))) as {
    post_id?: string;
    post_ids?: string[];
    text?: string;
    media_url?: string;
    media_type?: string;
    channel_id?: string;
    target_channel?: string;
  };
  // The frontend sends `target_channel`; keep both names accepted.
  const channel_id = body.channel_id ?? body.target_channel;

  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    return NextResponse.json(
      { error: "No active social media accounts configured" },
      { status: 400 },
    );
  }

  const posts: PostToSpread[] = [];

  if (body.text) {
    // Custom inline content — create a feed post under The Architect
    // first, then spread that post.
    const postId = randomUUID();
    const postMediaType =
      body.media_type === "video"
        ? "video/mp4"
        : body.media_type === "image"
          ? "image/png"
          : null;

    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, media_url, media_type,
        ai_like_count, media_source, channel_id
      )
      VALUES (
        ${postId}, ${ARCHITECT_PERSONA_ID}, ${body.text}, ${"spread"},
        ${body.media_url ?? null}, ${postMediaType},
        ${Math.floor(Math.random() * 200) + 50},
        ${"admin-spread"}, ${channel_id ?? null}
      )
    `;
    await sql`
      UPDATE ai_personas SET post_count = post_count + 1
      WHERE id = ${ARCHITECT_PERSONA_ID}
    `;
    if (channel_id) {
      await sql`
        UPDATE channels SET post_count = post_count + 1, updated_at = NOW()
        WHERE id = ${channel_id}
      `;
    }

    posts.push({
      id: postId,
      content: body.text,
      media_url: body.media_url ?? null,
      media_type: body.media_type ?? null,
      persona_name: "AIG!itch",
      persona_emoji: "🤖",
    });
  } else {
    const ids = body.post_ids ?? (body.post_id ? [body.post_id] : []);
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "Provide post_id, post_ids, or text" },
        { status: 400 },
      );
    }

    const dbPosts = (await sql`
      SELECT p.id, p.content, p.media_url, p.media_type,
             a.display_name as persona_name, a.avatar_emoji as persona_emoji
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.id = ANY(${ids})
    `) as unknown as PostToSpread[];
    posts.push(...dbPosts);

    if (channel_id && ids.length > 0) {
      await sql`
        UPDATE posts SET channel_id = ${channel_id}
        WHERE id = ANY(${ids}) AND channel_id IS NULL
      `;
      await sql`
        UPDATE channels
        SET post_count = post_count + ${ids.length}, updated_at = NOW()
        WHERE id = ${channel_id}
      `;
    }
  }

  if (posts.length === 0) {
    return NextResponse.json({ error: "No posts found" }, { status: 404 });
  }

  let totalPosted = 0;
  let totalFailed = 0;
  const details: SpreadDetail[] = [];

  for (const post of posts) {
    const isVideo =
      post.media_type === "video" ||
      (post.media_type?.startsWith("video/") ?? false) ||
      (post.media_url?.includes(".mp4") ?? false);

    if (!post.media_url) {
      const fallback = await pickFallbackMedia();
      if (fallback) {
        post.media_url = fallback;
        post.media_type = "image";
      }
    }

    for (const account of accounts) {
      const platform = account.platform as MarketingPlatform;
      if (platform === "youtube" && !isVideo) continue;

      try {
        const adapted = await adaptContentForPlatform(
          post.content ?? "",
          post.persona_name,
          post.persona_emoji,
          platform,
          post.media_url,
        );

        const marketingPostId = randomUUID();
        await sql`
          INSERT INTO marketing_posts (
            id, platform, source_post_id, persona_id,
            adapted_content, adapted_media_url, status, created_at
          )
          VALUES (
            ${marketingPostId}, ${platform}, ${post.id}, ${ARCHITECT_PERSONA_ID},
            ${adapted.text}, ${post.media_url}, 'posting', NOW()
          )
        `;

        const result = await postToPlatform(
          platform,
          account,
          adapted.text,
          post.media_url,
        );

        if (result.success) {
          await sql`
            UPDATE marketing_posts
            SET status = 'posted',
                platform_post_id = ${result.platformPostId ?? null},
                platform_url = ${result.platformUrl ?? null},
                posted_at = NOW()
            WHERE id = ${marketingPostId}
          `;
          totalPosted++;
          details.push({ postId: post.id, platform, status: "posted" });
        } else {
          await sql`
            UPDATE marketing_posts
            SET status = 'failed',
                error_message = ${result.error ?? "Unknown"}
            WHERE id = ${marketingPostId}
          `;
          totalFailed++;
          details.push({
            postId: post.id,
            platform,
            status: "failed",
            error: result.error,
          });
        }
      } catch (err) {
        totalFailed++;
        details.push({
          postId: post.id,
          platform,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return NextResponse.json({
    success: true,
    posts_found: posts.length,
    posted: totalPosted,
    failed: totalFailed,
    platforms: accounts.map((a) => a.platform),
    details,
  });
}

// ── GET ─────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureMarketingTables();
  const sql = getDb();

  const accounts = await getActiveAccounts();

  const recentSpreads = (await sql`
    SELECT id, platform, source_post_id, adapted_content, adapted_media_url,
           status, platform_url, posted_at, error_message
    FROM marketing_posts
    ORDER BY created_at DESC
    LIMIT 50
  `) as unknown as Record<string, unknown>[];

  const statRows = (await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'posted') AS posted,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM marketing_posts
  `) as unknown as { total: string; posted: string; failed: string }[];
  const stats = statRows[0] ?? { total: "0", posted: "0", failed: "0" };

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      platform: a.platform,
      name: a.account_name || a.platform,
    })),
    recent_spreads: recentSpreads,
    spreads: recentSpreads, // mobile app alias
    stats: {
      total: Number(stats.total),
      posted: Number(stats.posted),
      failed: Number(stats.failed),
    },
  });
}
