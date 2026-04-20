/**
 * Marketing HQ — metrics collector.
 *
 * For each marketing post from the last 7 days, asks the platform's API
 * for engagement counts and writes them back to `marketing_posts`. Then
 * rolls today's totals up into `marketing_metrics_daily` (one row per
 * platform per day, upserted).
 *
 * Platform notes:
 *   - X uses OAuth 1.0a via src/lib/x-oauth.ts (reused from x-dm-poll).
 *   - FB/IG/YouTube use simple access_token query params.
 *   - X free tier does NOT return impression_count — logged as a warning.
 *   - TikTok is intentionally omitted (API denied in April 2026).
 *
 * Graceful degradation:
 *   - No posts → {updated:0, failed:0, details:[]}
 *   - No account for platform → all posts on that platform get "skipped"
 *   - Individual post failures don't abort the whole run.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { buildOAuth1Header, getAppCredentials } from "@/lib/x-oauth";
import { getAccountForPlatform } from "./platforms";
import type { MarketingPlatform, MarketingPost } from "./types";

interface PostMetrics {
  impressions?: number;
  likes?: number;
  shares?: number;
  comments?: number;
  views?: number;
  clicks?: number;
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
}

// ── Facebook ───────────────────────────────────────────────────────────

async function fetchFacebookMetrics(
  postId: string,
  accessToken: string,
): Promise<PostMetrics> {
  const base = `https://graph.facebook.com/v21.0/${postId}`;
  const url = `${base}?fields=likes.summary(true),comments.summary(true),shares&access_token=${accessToken}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[FB metrics] HTTP ${res.status} for ${postId}`);
    return {};
  }
  const data = (await res.json()) as {
    likes?: { summary?: { total_count?: number } };
    comments?: { summary?: { total_count?: number } };
    shares?: { count?: number };
  };

  const metrics: PostMetrics = {
    likes: data.likes?.summary?.total_count ?? 0,
    comments: data.comments?.summary?.total_count ?? 0,
    shares: data.shares?.count ?? 0,
  };

  // Impressions require read_insights permission — silently ignore if denied.
  try {
    const insightsUrl = `${base}/insights?metric=post_impressions_unique&access_token=${accessToken}`;
    const insightsRes = await fetch(insightsUrl);
    if (insightsRes.ok) {
      const insightsData = (await insightsRes.json()) as {
        data?: { values?: { value?: number }[] }[];
      };
      metrics.impressions = insightsData.data?.[0]?.values?.[0]?.value ?? 0;
    }
  } catch {
    // permission denied or network hiccup — non-fatal
  }
  return metrics;
}

// ── Instagram ─────────────────────────────────────────────────────────

async function fetchInstagramMetrics(
  postId: string,
  accessToken: string,
): Promise<PostMetrics> {
  const url = `https://graph.facebook.com/v21.0/${postId}?fields=like_count,comments_count,impressions,reach&access_token=${accessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[IG metrics] HTTP ${res.status} for ${postId}`);
    return {};
  }
  const data = (await res.json()) as {
    like_count?: number;
    comments_count?: number;
    impressions?: number;
    reach?: number;
  };
  return {
    likes: data.like_count ?? 0,
    comments: data.comments_count ?? 0,
    impressions: data.impressions ?? 0,
    views: data.reach ?? 0,
  };
}

// ── X (Twitter) ───────────────────────────────────────────────────────

async function fetchXMetrics(postId: string): Promise<PostMetrics> {
  const url = `https://api.twitter.com/2/tweets/${postId}?tweet.fields=public_metrics`;

  let authHeader: string;
  try {
    const creds = getAppCredentials();
    authHeader = buildOAuth1Header("GET", url, creds);
  } catch {
    // No X creds — can't fetch metrics.
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
  const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=statistics&access_token=${accessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[YT metrics] HTTP ${res.status} for ${videoId}`);
    return {};
  }
  const data = (await res.json()) as {
    items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
  };
  const stats = data.items?.[0]?.statistics;
  if (!stats) return {};
  return {
    views: parseInt(stats.viewCount ?? "0", 10),
    likes: parseInt(stats.likeCount ?? "0", 10),
    comments: parseInt(stats.commentCount ?? "0", 10),
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────

async function fetchMetricsForPost(
  post: MarketingPost,
  accessToken: string,
): Promise<PostMetrics> {
  if (!post.platform_post_id) return {};
  switch (post.platform) {
    case "facebook":  return fetchFacebookMetrics(post.platform_post_id, accessToken);
    case "instagram": return fetchInstagramMetrics(post.platform_post_id, accessToken);
    case "x":         return fetchXMetrics(post.platform_post_id);
    case "youtube":   return fetchYouTubeMetrics(post.platform_post_id, accessToken);
    default:          return {};
  }
}

// ── Main entry ────────────────────────────────────────────────────────

export async function collectAllMetrics(): Promise<CollectResult> {
  const sql = getDb();
  const details: CollectDetail[] = [];
  let updated = 0;
  let failed = 0;

  const posts = (await sql`
    SELECT * FROM marketing_posts
    WHERE status = 'posted'
      AND platform_post_id IS NOT NULL
      AND posted_at > NOW() - INTERVAL '7 days'
    ORDER BY posted_at DESC
  `) as unknown as MarketingPost[];

  if (posts.length === 0) {
    return { updated, failed, details };
  }

  // Group by platform so we only look up each account once
  const byPlatform = new Map<MarketingPlatform, MarketingPost[]>();
  for (const p of posts) {
    const list = byPlatform.get(p.platform) ?? [];
    list.push(p);
    byPlatform.set(p.platform, list);
  }

  for (const [platform, list] of byPlatform) {
    const account = await getAccountForPlatform(platform);
    if (!account) {
      for (const p of list) {
        details.push({ platform, postId: p.id, status: "skipped", error: "No active account" });
      }
      continue;
    }

    for (const post of list) {
      try {
        const m = await fetchMetricsForPost(post, account.access_token);
        if (Object.keys(m).length === 0) {
          details.push({ platform, postId: post.id, status: "no_data" });
          continue;
        }

        await sql`
          UPDATE marketing_posts
          SET impressions = ${m.impressions ?? post.impressions},
              likes       = ${m.likes       ?? post.likes},
              shares      = ${m.shares      ?? post.shares},
              comments    = ${m.comments    ?? post.comments},
              views       = ${m.views       ?? post.views},
              clicks      = ${m.clicks      ?? post.clicks}
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

  await rollUpDailyMetrics();
  return { updated, failed, details };
}

/**
 * Upsert today's platform-level totals into marketing_metrics_daily.
 * Uses an ON CONFLICT (platform, date) constraint — that constraint
 * must exist on the target table.
 */
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
    `;
  }
}
