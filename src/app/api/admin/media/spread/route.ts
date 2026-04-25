/**
 * POST /api/admin/media/spread
 *
 * Spread The Architect's existing posts to all active social media
 * platforms. Body: `{ post_ids?: string[] }` — when omitted, every
 * Architect post that hasn't already been spread (no
 * `marketing_posts.source_post_id` row) is processed.
 *
 * Each post × platform pair: adapt content → INSERT marketing_posts
 * (status='posting') → postToPlatform → flip to 'posted' or 'failed'.
 * Skips YouTube for non-video posts. Returns a per-attempt detail
 * list so the admin UI can surface failures.
 *
 * Per the v1.7.5 platforms port, only X is fully wired today —
 * IG/FB/YT return deferral errors that surface as `failed` here
 * without breaking the run.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { adaptContentForPlatform } from "@/lib/marketing/content-adapter";
import { ensureMarketingTables } from "@/lib/marketing/ensure-tables";
import { getActiveAccounts, postToPlatform } from "@/lib/marketing/platforms";
import type { MarketingPlatform } from "@/lib/marketing/types";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const ARCHITECT_PERSONA_ID = "glitch-000";

interface ArchitectPost {
  id: string;
  content: string;
  media_url: string | null;
  media_type: string | null;
}

interface SpreadDetail {
  postId: string;
  platform: string;
  status: "posted" | "failed";
  error?: string;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureMarketingTables();
  const sql = getDb();

  // Body parsing: support both JSON and multipart/form-data (legacy
  // admin UI uses FormData when submitting from the dashboard).
  let postIds: string[] | undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const idsRaw = formData.get("post_ids");
    if (typeof idsRaw === "string") {
      try {
        postIds = JSON.parse(idsRaw) as string[];
      } catch {
        // Ignore malformed FormData — falls through to "spread all".
      }
    }
  } else {
    const body = (await request.json().catch(() => ({}))) as {
      post_ids?: string[];
    };
    postIds = body.post_ids;
  }

  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    return NextResponse.json(
      {
        error:
          "No active social media accounts configured. Go to Marketing tab to set up platforms.",
      },
      { status: 400 },
    );
  }

  const posts =
    postIds && postIds.length > 0
      ? ((await sql`
          SELECT p.id, p.content, p.media_url, p.media_type
          FROM posts p
          WHERE p.persona_id = ${ARCHITECT_PERSONA_ID}
            AND p.id = ANY(${postIds})
        `) as unknown as ArchitectPost[])
      : ((await sql`
          SELECT p.id, p.content, p.media_url, p.media_type
          FROM posts p
          WHERE p.persona_id = ${ARCHITECT_PERSONA_ID}
            AND NOT EXISTS (
              SELECT 1 FROM marketing_posts mp WHERE mp.source_post_id = p.id
            )
          ORDER BY p.created_at DESC
        `) as unknown as ArchitectPost[]);

  if (posts.length === 0) {
    return NextResponse.json({
      success: true,
      message: "All Architect posts have already been spread to marketing.",
      spread: 0,
    });
  }

  let totalPosted = 0;
  let totalFailed = 0;
  const details: SpreadDetail[] = [];

  for (const post of posts) {
    const isVideo = post.media_type === "video";
    const caption = post.content ?? "";

    for (const account of accounts) {
      const platform = account.platform as MarketingPlatform;
      if (platform === "youtube" && !isVideo) continue;

      try {
        const adapted = await adaptContentForPlatform(
          caption,
          "🙏 The Architect",
          "🕉️",
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
                error_message = ${result.error ?? "Unknown error"}
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
    postsFound: posts.length,
    posted: totalPosted,
    failed: totalFailed,
    details,
  });
}
