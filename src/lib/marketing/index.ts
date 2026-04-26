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

interface PlatformBreakdown {
  platform: string;
  posted: number;
  queued: number;
  failed: number;
  impressions: number;
  likes: number;
  views: number;
  lastPostedAt: string | null;
}

interface RecentMarketingPost {
  id: string;
  platform: string;
  adapted_content: string;
  status: string;
  platform_url: string | null;
  impressions: number;
  likes: number;
  views: number;
  posted_at: string | null;
  created_at: string;
  persona_display_name: string | null;
  persona_emoji: string | null;
}

interface DailyMetric {
  date: string;
  platform: string;
  posts_published: number;
  total_impressions: number;
  total_likes: number;
  total_views: number;
}

interface CampaignRow {
  id: string;
  name: string;
  description: string;
  status: string;
  target_platforms: string;
  content_strategy: string;
  posts_per_day: number;
  created_at: string;
  updated_at: string;
}

export interface MarketingStats {
  totalPosted: number;
  totalQueued: number;
  totalFailed: number;
  totalImpressions: number;
  totalLikes: number;
  totalViews: number;
  platformBreakdown: PlatformBreakdown[];
  recentPosts: RecentMarketingPost[];
  dailyMetrics: DailyMetric[];
  campaigns: CampaignRow[];
}

/**
 * Aggregate marketing stats for the admin dashboard. One JOIN-heavy
 * read covering totals, per-platform breakdown, recent posts, daily
 * metrics, and campaigns. Returns zeroed values when tables don't
 * exist yet (fresh env).
 */
export async function getMarketingStats(): Promise<MarketingStats> {
  await ensureMarketingTables();
  const sql = getDb();

  const totals = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'posted') AS total_posted,
      COUNT(*) FILTER (WHERE status = 'queued') AS total_queued,
      COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
      COALESCE(SUM(impressions) FILTER (WHERE status = 'posted'), 0) AS total_impressions,
      COALESCE(SUM(likes) FILTER (WHERE status = 'posted'), 0) AS total_likes,
      COALESCE(SUM(views) FILTER (WHERE status = 'posted'), 0) AS total_views
    FROM marketing_posts
  `) as unknown as {
    total_posted: number | string;
    total_queued: number | string;
    total_failed: number | string;
    total_impressions: number | string;
    total_likes: number | string;
    total_views: number | string;
  }[];
  const t = totals[0] ?? {
    total_posted: 0,
    total_queued: 0,
    total_failed: 0,
    total_impressions: 0,
    total_likes: 0,
    total_views: 0,
  };

  const breakdown = (await sql`
    SELECT
      mp.platform,
      COUNT(*) FILTER (WHERE mp.status = 'posted') AS posted,
      COUNT(*) FILTER (WHERE mp.status = 'queued') AS queued,
      COUNT(*) FILTER (WHERE mp.status = 'failed') AS failed,
      COALESCE(SUM(mp.impressions), 0) AS impressions,
      COALESCE(SUM(mp.likes), 0) AS likes,
      COALESCE(SUM(mp.views), 0) AS views,
      (
        SELECT mpa.last_posted_at FROM marketing_platform_accounts mpa
        WHERE mpa.platform = mp.platform AND mpa.is_active = true LIMIT 1
      ) AS last_posted_at
    FROM marketing_posts mp
    GROUP BY mp.platform
    ORDER BY posted DESC
  `) as unknown as Array<
    Omit<PlatformBreakdown, "lastPostedAt"> & { last_posted_at: string | null }
  >;

  const recentPosts = (await sql`
    SELECT
      mp.id, mp.platform, mp.adapted_content, mp.status, mp.platform_url,
      mp.impressions, mp.likes, mp.views, mp.posted_at, mp.created_at,
      a.display_name AS persona_display_name, a.avatar_emoji AS persona_emoji
    FROM marketing_posts mp
    LEFT JOIN ai_personas a ON a.id = mp.persona_id
    ORDER BY mp.created_at DESC
    LIMIT 50
  `) as unknown as RecentMarketingPost[];

  const dailyMetrics = (await sql`
    SELECT date, platform, posts_published, total_impressions, total_likes, total_views
    FROM marketing_metrics_daily
    WHERE date >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')
    ORDER BY date DESC
  `.catch(() => [])) as unknown as DailyMetric[];

  const campaigns = (await sql`
    SELECT id, name, description, status, target_platforms,
           content_strategy, posts_per_day, created_at, updated_at
    FROM marketing_campaigns
    ORDER BY updated_at DESC
  `.catch(() => [])) as unknown as CampaignRow[];

  return {
    totalPosted: Number(t.total_posted),
    totalQueued: Number(t.total_queued),
    totalFailed: Number(t.total_failed),
    totalImpressions: Number(t.total_impressions),
    totalLikes: Number(t.total_likes),
    totalViews: Number(t.total_views),
    platformBreakdown: breakdown.map((b) => ({
      platform: b.platform,
      posted: Number(b.posted),
      queued: Number(b.queued),
      failed: Number(b.failed),
      impressions: Number(b.impressions),
      likes: Number(b.likes),
      views: Number(b.views),
      lastPostedAt: b.last_posted_at,
    })),
    recentPosts,
    dailyMetrics,
    campaigns,
  };
}
