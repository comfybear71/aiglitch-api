import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { adaptContentForPlatform, pickTopPosts } from "./content-adapter";
import { ensureMarketingTables } from "./ensure-tables";
import { getActiveAccounts, postToPlatform } from "./platforms";
import { pickFallbackMedia } from "./spread-post";
import { ALL_PLATFORMS, type MarketingPlatform } from "./types";

export * from "./types";
export { getAccountForPlatform } from "./platforms";
export { collectAllMetrics } from "./metrics-collector";
export type { CollectResult, CollectDetail } from "./metrics-collector";
export { pickTopPosts } from "./content-adapter";
export { getActiveAccounts } from "./platforms";

interface MarketingDetail {
  platform: string;
  status: "posted" | "failed" | "queued" | "skipped";
  postId?: string;
  error?: string;
}

interface MarketingCycleResult extends Record<string, unknown> {
  posted: number;
  failed: number;
  skipped: number;
  details: MarketingDetail[];
}

/**
 * Pick top AIG!itch posts → adapt per platform → post to all active
 * accounts. Called by the `/api/marketing-post` cron every 3h.
 *
 * When no accounts are configured, queues posts for the showcase
 * page instead of failing. Respects `marketing_campaigns.target_platforms`
 * + `posts_per_day` when an active campaign exists.
 */
export async function runMarketingCycle(): Promise<MarketingCycleResult> {
  await ensureMarketingTables();
  const sql = getDb();
  const accounts = await getActiveAccounts();
  const details: MarketingDetail[] = [];

  // No platforms configured → queue for showcase, skip posting.
  if (accounts.length === 0) {
    const topPosts = await pickTopPosts(3);
    for (const post of topPosts) {
      for (const platform of ALL_PLATFORMS) {
        const adapted = await adaptContentForPlatform(
          post.content,
          post.display_name,
          post.avatar_emoji,
          platform,
          post.media_url,
        );
        await sql`
          INSERT INTO marketing_posts (
            id, platform, source_post_id, persona_id,
            adapted_content, adapted_media_url, status, created_at
          ) VALUES (
            ${randomUUID()}, ${platform}, ${post.id}, ${post.persona_id},
            ${adapted.text}, ${post.media_url}, 'queued', NOW()
          )
        `;
      }
    }
    return {
      posted: 0,
      failed: 0,
      skipped: topPosts.length * ALL_PLATFORMS.length,
      details: [
        {
          platform: "all",
          status: "queued",
          error: "No platform accounts configured — content queued for showcase",
        },
      ],
    };
  }

  // Active campaign filter + posts-per-cycle calc.
  const campaignRows = (await sql`
    SELECT id, target_platforms, posts_per_day
    FROM marketing_campaigns
    WHERE status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `.catch(() => [])) as unknown as {
    id: string;
    target_platforms: string;
    posts_per_day: number;
  }[];
  const campaign = campaignRows[0] ?? null;
  const campaignPlatforms = campaign
    ? campaign.target_platforms.split(",").filter(Boolean)
    : null;
  // ~24 cycles/day (cron runs hourly-ish). Default 3 posts when no campaign.
  const postsPerCycle = campaign
    ? Math.max(1, Math.ceil(campaign.posts_per_day / 24))
    : 3;

  const targetAccounts = campaignPlatforms
    ? accounts.filter((a) => campaignPlatforms.includes(a.platform))
    : accounts;

  const topPosts = await pickTopPosts(postsPerCycle);
  let posted = 0;
  let failed = 0;
  let skipped = 0;

  for (const post of topPosts) {
    const isVideo = post.media_type?.startsWith("video") ?? false;

    let mediaUrl = post.media_url;
    if (!mediaUrl) {
      mediaUrl = (await pickFallbackMedia()) ?? null;
    }

    for (const account of targetAccounts) {
      const platform = account.platform as MarketingPlatform;

      if (platform === "youtube" && !isVideo) {
        skipped++;
        details.push({
          platform,
          status: "skipped",
          error: `${platform} requires video, post is ${post.media_type ?? "text"}`,
        });
        continue;
      }

      try {
        const adapted = await adaptContentForPlatform(
          post.content,
          post.display_name,
          post.avatar_emoji,
          platform,
          mediaUrl,
        );

        const marketingPostId = randomUUID();
        await sql`
          INSERT INTO marketing_posts (
            id, campaign_id, platform, source_post_id, persona_id,
            adapted_content, adapted_media_url, status, created_at
          ) VALUES (
            ${marketingPostId}, ${campaign?.id ?? null}, ${platform},
            ${post.id}, ${post.persona_id},
            ${adapted.text}, ${mediaUrl}, 'posting', NOW()
          )
        `;

        const result = await postToPlatform(platform, account, adapted.text, mediaUrl);

        if (result.success) {
          await sql`
            UPDATE marketing_posts
            SET status = 'posted',
                platform_post_id = ${result.platformPostId ?? null},
                platform_url = ${result.platformUrl ?? null},
                posted_at = NOW()
            WHERE id = ${marketingPostId}
          `;
          await sql`
            UPDATE marketing_platform_accounts
            SET last_posted_at = NOW()
            WHERE id = ${account.id}
          `;
          posted++;
          details.push({ platform, status: "posted", postId: result.platformPostId });
        } else {
          await sql`
            UPDATE marketing_posts
            SET status = 'failed',
                error_message = ${result.error ?? "Unknown error"}
            WHERE id = ${marketingPostId}
          `;
          failed++;
          details.push({ platform, status: "failed", error: result.error });
        }
      } catch (err) {
        failed++;
        details.push({
          platform,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { posted, failed, skipped, details };
}
