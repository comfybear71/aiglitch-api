/**
 * Marketing HQ — metrics collector.
 *
 * For each marketing post from the last N days, asks the platform's API
 * for engagement counts and writes them back to `marketing_posts`. Then
 * rolls today's totals up into `marketing_metrics_daily` (one row per
 * platform per day, upserted).
 *
 * Platform notes:
 *   - X uses OAuth 1.0a via src/lib/x-oauth.ts
 *   - IG/FB use Graph API Insights endpoints (not deprecated direct fields)
 *   - YouTube stores viewCount in `views`
 *   - Telegram: channel subscriber count via getChat (post views not in Bot API)
 *   - TikTok is intentionally omitted (API denied in April 2026)
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { buildOAuth1Header, getAppCredentials } from "@/lib/x-oauth";
import { ensureMarketingTables } from "./ensure-tables";
import {
  fetchFacebookPostEngagement,
  getAccountForPlatform,
  normalizeFacebookPostId,
  refreshYouTubeToken,
  resolveFacebookPageId,
  resolveTelegramChatId,
} from "./platforms";
import type { MarketingPlatform, MarketingPost } from "./types";

/** How far back to refresh post-level metrics each cron run. */
export const METRICS_LOOKBACK_DAYS = 30;

/** Cap per platform per manual sync — keeps background job under ~60s. */
export const METRICS_SYNC_MAX_POSTS_PER_PLATFORM = 15;

interface PostMetrics {
  impressions?: number;
  likes?: number;
  shares?: number;
  comments?: number;
  views?: number;
  clicks?: number;
  /** Resolved feed post id when a stale Facebook photo id was remapped. */
  feedPostId?: string;
}

export interface CollectDetail {
  platform: string;
  postId: string;
  status: "updated" | "no_data" | "skipped" | "error";
  error?: string;
}

export interface CollectResult {
  updated: number;
  failed: number;
  details: CollectDetail[];
  followersUpdated?: number;
}

function parseInsightsValues(
  data: unknown,
): Record<string, number> {
  const rows = (data as { data?: { name?: string; values?: { value?: number | Record<string, number> }[] }[] })
    ?.data;
  const out: Record<string, number> = {};
  for (const row of rows ?? []) {
    if (!row.name) continue;
    const raw = row.values?.[0]?.value;
    if (typeof raw === "number") {
      out[row.name] = raw;
    } else if (raw && typeof raw === "object") {
      out[row.name] = Object.values(raw).reduce(
        (sum, n) => sum + (typeof n === "number" ? n : 0),
        0,
      );
    }
  }
  return out;
}

// ── Facebook ───────────────────────────────────────────────────────────

async function fetchFacebookMetrics(
  postId: string,
  accessToken: string,
  pageId?: string | null,
  postedAt?: string | null,
): Promise<PostMetrics> {
  const engagement = await fetchFacebookPostEngagement(
    pageId ?? "",
    postId,
    accessToken,
    { postedAt },
  );
  if (!engagement) return {};

  const metrics: PostMetrics = {
    likes: engagement.likes,
    comments: engagement.comments,
    shares: engagement.shares,
    feedPostId: engagement.feedPostId,
  };

  const graphId =
    engagement.feedPostId ??
    normalizeFacebookPostId(pageId ?? "", postId);
  const base = `https://graph.facebook.com/v21.0/${graphId}`;
  try {
    const insightsUrl = `${base}/insights?metric=post_impressions_unique,post_impressions&access_token=${encodeURIComponent(accessToken)}`;
    const insightsRes = await fetch(insightsUrl);
    if (insightsRes.ok) {
      const parsed = parseInsightsValues(await insightsRes.json());
      metrics.impressions =
        parsed.post_impressions_unique ?? parsed.post_impressions ?? 0;
    }
  } catch {
    // insights optional — non-fatal
  }
  return metrics;
}

// ── Instagram ─────────────────────────────────────────────────────────

const IG_GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Instagram insight metrics vary by media_product_type. Reels and v22+
 * reject `impressions`; likes/comments belong on the media object, not insights.
 */
export function pickInstagramInsightMetrics(
  mediaProductType?: string | null,
): string {
  const t = (mediaProductType ?? "FEED").toUpperCase();
  if (t === "REELS" || t === "CLIP") {
    // Reels: no impressions (v22+); plays/views vary by API version — reach+shares always safe.
    return "reach,shares,saved";
  }
  if (t === "STORY") {
    return "reach,replies,navigation";
  }
  // FEED / CAROUSEL / default — likes+comments valid on insights for static feed media.
  return "reach,likes,comments,shares,saved";
}

async function fetchInstagramMediaFields(
  mediaId: string,
  accessToken: string,
): Promise<{
  like_count: number;
  comments_count: number;
  media_product_type?: string;
} | null> {
  const url = `${IG_GRAPH}/${mediaId}?fields=like_count,comments_count,media_type,media_product_type&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(
      `[IG metrics] media fields HTTP ${res.status} for ${mediaId}: ${errText.slice(0, 200)}`,
    );
    return null;
  }
  const data = (await res.json()) as {
    like_count?: number;
    comments_count?: number;
    media_product_type?: string;
  };
  return {
    like_count: data.like_count ?? 0,
    comments_count: data.comments_count ?? 0,
    media_product_type: data.media_product_type,
  };
}

async function fetchInstagramInsights(
  mediaId: string,
  accessToken: string,
  metrics: string,
): Promise<Record<string, number>> {
  const url = `${IG_GRAPH}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(
      `[IG metrics] insights HTTP ${res.status} for ${mediaId}: ${errText.slice(0, 200)}`,
    );
    return {};
  }
  return parseInsightsValues(await res.json());
}

async function fetchInstagramMetrics(
  mediaId: string,
  accessToken: string,
): Promise<PostMetrics> {
  const media = await fetchInstagramMediaFields(mediaId, accessToken);
  if (!media) return {};

  const parsed = await fetchInstagramInsights(
    mediaId,
    accessToken,
    pickInstagramInsightMetrics(media.media_product_type),
  );
  const insights =
    Object.keys(parsed).length > 0
      ? parsed
      : await fetchInstagramInsights(mediaId, accessToken, "reach");

  const productType = (media.media_product_type ?? "").toUpperCase();
  const reach = insights.reach ?? 0;
  const viewsMetric = insights.views ?? insights.plays ?? 0;

  return {
    likes: media.like_count,
    comments: media.comments_count,
    shares: insights.shares ?? 0,
    views:
      productType === "REELS" || productType === "CLIP"
        ? viewsMetric || reach
        : reach,
    impressions: reach,
  };
}

async function collectInstagramFollowers(): Promise<number> {
  const account = await getAccountForPlatform("instagram");
  const token =
    process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || account?.access_token;
  const igUserId =
    process.env.INSTAGRAM_USER_ID?.trim() || account?.account_id;
  if (!token || !igUserId) return 0;

  const url = `${IG_GRAPH}/${igUserId}?fields=followers_count&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[IG metrics] followers HTTP ${res.status}`);
    return 0;
  }
  const data = (await res.json()) as { followers_count?: number };
  const followers = data.followers_count ?? 0;

  const sql = getDb();
  const today = new Date().toISOString().slice(0, 10);
  await sql`
    INSERT INTO marketing_metrics_daily
      (id, platform, date, posts_published, total_impressions, total_likes,
       total_shares, total_comments, total_views, total_clicks,
       follower_count, follower_growth, collected_at)
    VALUES
      (${randomUUID()}, 'instagram', ${today}, 0, 0, 0, 0, 0, 0, 0,
       ${followers}, 0, NOW())
    ON CONFLICT (platform, date)
    DO UPDATE SET
      follower_count = EXCLUDED.follower_count,
      collected_at = NOW()
  `.catch((err) => {
    console.error("[IG metrics] daily follower rollup failed:", err);
  });

  console.log(`[IG metrics] stored ${followers} followers for ${igUserId}`);
  return 1;
}

async function collectFacebookFollowers(): Promise<number> {
  const account = await getAccountForPlatform("facebook");
  const token =
    process.env.FACEBOOK_ACCESS_TOKEN?.trim() || account?.access_token;
  const pageId = resolveFacebookPageId(account);
  if (!token || !pageId) {
    console.warn(
      "[FB metrics] skipped fan_count — missing token or FACEBOOK_PAGE_ID",
    );
    return 0;
  }

  const url = `${IG_GRAPH}/${pageId}?fields=fan_count,followers_count&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[FB metrics] fan_count HTTP ${res.status}`);
    return 0;
  }
  const data = (await res.json()) as {
    fan_count?: number;
    followers_count?: number;
  };
  const followers = data.followers_count ?? data.fan_count ?? 0;

  const sql = getDb();
  const today = new Date().toISOString().slice(0, 10);
  await sql`
    INSERT INTO marketing_metrics_daily
      (id, platform, date, posts_published, total_impressions, total_likes,
       total_shares, total_comments, total_views, total_clicks,
       follower_count, follower_growth, collected_at)
    VALUES
      (${randomUUID()}, 'facebook', ${today}, 0, 0, 0, 0, 0, 0, 0,
       ${followers}, 0, NOW())
    ON CONFLICT (platform, date)
    DO UPDATE SET
      follower_count = EXCLUDED.follower_count,
      collected_at = NOW()
  `.catch((err) => {
    console.error("[FB metrics] daily follower rollup failed:", err);
  });

  console.log(`[FB metrics] stored ${followers} followers for page ${pageId}`);
  return 1;
}

// ── X (Twitter) ───────────────────────────────────────────────────────

async function fetchXMetrics(postId: string): Promise<PostMetrics> {
  const url = `https://api.twitter.com/2/tweets/${postId}?tweet.fields=public_metrics`;

  let authHeader: string;
  try {
    const creds = getAppCredentials();
    authHeader = buildOAuth1Header("GET", url, creds);
  } catch {
    return {};
  }

  const res = await fetch(url, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    console.error(`[X metrics] HTTP ${res.status} for ${postId}`);
    return {};
  }
  const data = (await res.json()) as {
    data?: {
      public_metrics?: {
        retweet_count?: number;
        reply_count?: number;
        like_count?: number;
        quote_count?: number;
        impression_count?: number;
      };
    };
  };
  const pm = data.data?.public_metrics;
  if (!pm) return {};

  return {
    likes: pm.like_count ?? 0,
    shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
    comments: pm.reply_count ?? 0,
    impressions: pm.impression_count ?? 0,
    views: pm.impression_count ?? 0,
  };
}

// ── YouTube ───────────────────────────────────────────────────────────

async function fetchYouTubeMetrics(
  videoId: string,
  accessToken: string,
): Promise<PostMetrics> {
  let token = accessToken;
  let url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=statistics&access_token=${encodeURIComponent(token)}`;
  let res = await fetch(url);
  if (res.status === 401) {
    const refreshed = await refreshYouTubeToken();
    if (refreshed) {
      token = refreshed;
      url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=statistics&access_token=${encodeURIComponent(token)}`;
      res = await fetch(url);
    }
  }
  if (!res.ok) {
    console.error(`[YT metrics] HTTP ${res.status} for ${videoId}`);
    return {};
  }
  const data = (await res.json()) as {
    items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
  };
  const stats = data.items?.[0]?.statistics;
  if (!stats) return {};
  const views = parseInt(stats.viewCount ?? "0", 10);
  return {
    views,
    likes: parseInt(stats.likeCount ?? "0", 10),
    comments: parseInt(stats.commentCount ?? "0", 10),
  };
}

// ── Telegram (group/channel member count — post views not in Bot API) ─

async function fetchTelegramMemberCount(
  botToken: string,
  chatId: string,
): Promise<number | null> {
  // getChat often omits member_count on supergroups — getChatMemberCount is reliable.
  const countUrl = `https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${encodeURIComponent(chatId)}`;
  const countRes = await fetch(countUrl);
  if (countRes.ok) {
    const countData = (await countRes.json()) as {
      ok?: boolean;
      result?: number;
    };
    if (countData.ok && typeof countData.result === "number") {
      return countData.result;
    }
  } else {
    console.error(`[TG metrics] getChatMemberCount HTTP ${countRes.status}`);
  }

  const chatUrl = `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`;
  const chatRes = await fetch(chatUrl);
  if (!chatRes.ok) {
    console.error(`[TG metrics] getChat HTTP ${chatRes.status}`);
    return null;
  }
  const chatData = (await chatRes.json()) as {
    ok?: boolean;
    result?: { member_count?: number; title?: string };
  };
  if (!chatData.ok) return null;
  return chatData.result?.member_count ?? null;
}

async function collectTelegramFollowers(): Promise<number> {
  const account = await getAccountForPlatform("telegram");
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN?.trim() || account?.access_token;
  const chatId = resolveTelegramChatId(account);
  if (!botToken || !chatId) {
    console.warn(
      "[TG metrics] skipped — missing bot token or group/channel chat id (check TELEGRAM_GROUP_ID in .env.local)",
    );
    return 0;
  }

  const members = await fetchTelegramMemberCount(botToken, chatId);
  if (members == null) {
    console.warn(`[TG metrics] getChatMemberCount returned no count for ${chatId}`);
    return 0;
  }

  const sql = getDb();
  const today = new Date().toISOString().slice(0, 10);
  await sql`
    INSERT INTO marketing_metrics_daily
      (id, platform, date, posts_published, total_impressions, total_likes,
       total_shares, total_comments, total_views, total_clicks,
       follower_count, follower_growth, collected_at)
    VALUES
      (${randomUUID()}, 'telegram', ${today}, 0, 0, 0, 0, 0, 0, 0,
       ${members}, 0, NOW())
    ON CONFLICT (platform, date)
    DO UPDATE SET
      follower_count = EXCLUDED.follower_count,
      collected_at = NOW()
  `.catch((err) => {
    console.error("[TG metrics] daily rollup failed:", err);
  });

  console.log(`[TG metrics] stored ${members} subscribers for ${chatId}`);
  return 1;
}

// ── Dispatch ──────────────────────────────────────────────────────────

async function fetchMetricsForPost(
  post: MarketingPost,
  accessToken: string,
  opts?: { facebookPageId?: string | null },
): Promise<PostMetrics> {
  if (!post.platform_post_id) return {};
  switch (post.platform) {
    case "facebook":
      return fetchFacebookMetrics(
        post.platform_post_id,
        accessToken,
        opts?.facebookPageId,
        post.posted_at,
      );
    case "instagram":
      return fetchInstagramMetrics(post.platform_post_id, accessToken);
    case "x":
      return fetchXMetrics(post.platform_post_id);
    case "youtube":
      return fetchYouTubeMetrics(post.platform_post_id, accessToken);
    case "telegram":
      return {};
    default:
      return {};
  }
}

function hasMetricData(m: PostMetrics): boolean {
  return Object.values(m).some((v) => typeof v === "number" && v > 0);
}

// ── Main entry ────────────────────────────────────────────────────────

export async function collectAllMetrics(): Promise<CollectResult> {
  await ensureMarketingTables();
  const sql = getDb();
  const details: CollectDetail[] = [];
  let updated = 0;
  let failed = 0;

  let followersUpdated = await collectTelegramFollowers();
  followersUpdated += await collectInstagramFollowers();
  followersUpdated += await collectFacebookFollowers();

  const posts = (await sql`
    SELECT * FROM marketing_posts
    WHERE status = 'posted'
      AND platform_post_id IS NOT NULL
      AND platform != 'telegram'
      AND posted_at > NOW() - INTERVAL '1 day' * ${METRICS_LOOKBACK_DAYS}
    ORDER BY posted_at DESC
  `) as unknown as MarketingPost[];

  if (posts.length > 0) {
    const byPlatform = new Map<MarketingPlatform, MarketingPost[]>();
    for (const p of posts) {
      const list = byPlatform.get(p.platform) ?? [];
      list.push(p);
      byPlatform.set(p.platform, list);
    }

    for (const [platform, list] of byPlatform) {
      const batch = list.slice(0, METRICS_SYNC_MAX_POSTS_PER_PLATFORM);
      const account = await getAccountForPlatform(platform);
      if (!account) {
        for (const p of batch) {
          details.push({
            platform,
            postId: p.id,
            status: "skipped",
            error: "No active account",
          });
        }
        continue;
      }

      for (const post of batch) {
        try {
          const m = await fetchMetricsForPost(post, account.access_token, {
            facebookPageId:
              platform === "facebook"
                ? resolveFacebookPageId(account)
                : null,
          });
          if (!hasMetricData(m) && Object.keys(m).length === 0) {
            details.push({ platform, postId: post.id, status: "no_data" });
            continue;
          }

          const resolvedPlatformPostId =
            platform === "facebook" &&
            m.feedPostId &&
            m.feedPostId !== post.platform_post_id
              ? m.feedPostId
              : null;

          await sql`
            UPDATE marketing_posts
            SET impressions = ${m.impressions ?? post.impressions},
                likes       = ${m.likes ?? post.likes},
                shares      = ${m.shares ?? post.shares},
                comments    = ${m.comments ?? post.comments},
                views       = ${m.views ?? post.views},
                clicks      = ${m.clicks ?? post.clicks},
                platform_post_id = COALESCE(${resolvedPlatformPostId}, platform_post_id),
                metrics_updated_at = NOW()
            WHERE id = ${post.id}
          `;

          updated++;
          details.push({ platform, postId: post.id, status: "updated" });
        } catch (err) {
          failed++;
          details.push({
            platform,
            postId: post.id,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  await rollUpDailyMetrics();

  const postUpdatesByPlatform = new Map<string, number>();
  for (const d of details) {
    if (d.status !== "updated") continue;
    postUpdatesByPlatform.set(
      d.platform,
      (postUpdatesByPlatform.get(d.platform) ?? 0) + 1,
    );
  }
  for (const [platform, count] of postUpdatesByPlatform) {
    console.log(`[${platform} metrics] updated ${count} posts`);
  }

  return { updated, failed, details, followersUpdated };
}

async function rollUpDailyMetrics(): Promise<void> {
  const sql = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const aggregates = (await sql`
    SELECT
      platform,
      COUNT(*) FILTER (WHERE status = 'posted' AND DATE(posted_at) = ${today}::date) AS posts_published,
      COALESCE(SUM(impressions) FILTER (WHERE status = 'posted'), 0) AS total_impressions,
      COALESCE(SUM(likes)       FILTER (WHERE status = 'posted'), 0) AS total_likes,
      COALESCE(SUM(shares)      FILTER (WHERE status = 'posted'), 0) AS total_shares,
      COALESCE(SUM(comments)    FILTER (WHERE status = 'posted'), 0) AS total_comments,
      COALESCE(SUM(views)       FILTER (WHERE status = 'posted'), 0) AS total_views,
      COALESCE(SUM(clicks)      FILTER (WHERE status = 'posted'), 0) AS total_clicks
    FROM marketing_posts
    WHERE posted_at > NOW() - INTERVAL '1 day'
    GROUP BY platform
  `) as unknown as {
    platform: string;
    posts_published: number;
    total_impressions: number;
    total_likes: number;
    total_shares: number;
    total_comments: number;
    total_views: number;
    total_clicks: number;
  }[];

  for (const agg of aggregates) {
    await sql`
      INSERT INTO marketing_metrics_daily
        (id, platform, date, posts_published, total_impressions, total_likes,
         total_shares, total_comments, total_views, total_clicks, collected_at)
      VALUES
        (${randomUUID()}, ${agg.platform}, ${today},
         ${Number(agg.posts_published)}, ${Number(agg.total_impressions)},
         ${Number(agg.total_likes)}, ${Number(agg.total_shares)},
         ${Number(agg.total_comments)}, ${Number(agg.total_views)},
         ${Number(agg.total_clicks)}, NOW())
      ON CONFLICT (platform, date)
      DO UPDATE SET
        posts_published   = EXCLUDED.posts_published,
        total_impressions = EXCLUDED.total_impressions,
        total_likes       = EXCLUDED.total_likes,
        total_shares      = EXCLUDED.total_shares,
        total_comments    = EXCLUDED.total_comments,
        total_views       = EXCLUDED.total_views,
        total_clicks      = EXCLUDED.total_clicks,
        collected_at      = NOW()
    `.catch(() => undefined);
  }
}
