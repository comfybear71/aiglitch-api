/**
 * Platform-native metric labels for the marketing dashboard.
 * Avoids showing "Impressions: 0" on YouTube when the real metric is Views.
 */

import type { MarketingPlatform } from "./types";

export type MetricKey =
  | "impressions"
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "followers";

export interface PlatformMetricConfig {
  /** Which DB column drives the headline number on the platform card. */
  primaryKey: MetricKey;
  primaryLabel: string;
  /** Secondary chips — only keys we persist on marketing_posts / daily rollup. */
  secondary: Array<{ key: MetricKey; label: string }>;
  /** Post-level metrics available via platform API (false → show "—" until synced). */
  postMetricsSupported: boolean;
}

export const PLATFORM_METRIC_CONFIG: Record<
  MarketingPlatform,
  PlatformMetricConfig
> = {
  x: {
    primaryKey: "impressions",
    primaryLabel: "Impressions",
    secondary: [
      { key: "likes", label: "Likes" },
      { key: "shares", label: "Reposts" },
      { key: "comments", label: "Replies" },
    ],
    postMetricsSupported: true,
  },
  instagram: {
    primaryKey: "views",
    primaryLabel: "Reach",
    secondary: [
      { key: "followers", label: "Followers" },
      { key: "impressions", label: "Impressions" },
      { key: "likes", label: "Likes" },
      { key: "comments", label: "Comments" },
    ],
    postMetricsSupported: true,
  },
  facebook: {
    primaryKey: "impressions",
    primaryLabel: "Impressions",
    secondary: [
      { key: "followers", label: "Followers" },
      { key: "likes", label: "Reactions" },
      { key: "comments", label: "Comments" },
      { key: "shares", label: "Shares" },
    ],
    postMetricsSupported: true,
  },
  youtube: {
    primaryKey: "views",
    primaryLabel: "Views",
    secondary: [
      { key: "likes", label: "Likes" },
      { key: "comments", label: "Comments" },
    ],
    postMetricsSupported: true,
  },
  telegram: {
    primaryKey: "followers",
    primaryLabel: "Subscribers",
    secondary: [{ key: "views", label: "Post views" }],
    postMetricsSupported: false,
  },
};

export interface PlatformBreakdownRow {
  platform: string;
  posted: number;
  queued: number;
  failed: number;
  impressions: number;
  likes: number;
  views: number;
  shares: number;
  comments: number;
  lastPostedAt: string | null;
  lastMetricsSync: string | null;
  followers: number | null;
}

export interface EnrichedPlatformBreakdown extends PlatformBreakdownRow {
  successRate: number;
  primaryLabel: string;
  primaryValue: number | null;
  secondaryMetrics: Array<{ label: string; value: number | null }>;
  postMetricsSupported: boolean;
}

export function enrichPlatformBreakdown(
  row: PlatformBreakdownRow,
): EnrichedPlatformBreakdown {
  const cfg =
    PLATFORM_METRIC_CONFIG[row.platform as MarketingPlatform] ??
    ({
      primaryKey: "impressions",
      primaryLabel: "Impressions",
      secondary: [],
      postMetricsSupported: false,
    } satisfies PlatformMetricConfig);

  const attempts = row.posted + row.failed;
  const successRate =
    attempts > 0 ? Math.round((row.posted / attempts) * 1000) / 10 : 100;

  const primaryRaw =
    cfg.primaryKey === "followers"
      ? row.followers
      : (row[cfg.primaryKey as keyof PlatformBreakdownRow] as number);

  const primaryValue =
    cfg.primaryKey === "followers"
      ? primaryRaw != null && primaryRaw > 0
        ? primaryRaw
        : null
      : cfg.postMetricsSupported
        ? primaryRaw != null && (primaryRaw > 0 || row.lastMetricsSync)
          ? primaryRaw
          : null
        : primaryRaw != null && primaryRaw > 0
          ? primaryRaw
          : null;

  const secondaryMetrics = cfg.secondary.map(({ key, label }) => {
    if (key === "followers") {
      return { label, value: row.followers };
    }
    if (!cfg.postMetricsSupported) {
      return { label, value: null };
    }
    const v = row[key as keyof PlatformBreakdownRow] as number;
    return {
      label,
      value: v > 0 || row.lastMetricsSync ? v : null,
    };
  });

  return {
    ...row,
    postMetricsSupported: cfg.postMetricsSupported,
    successRate,
    primaryLabel: cfg.primaryLabel,
    primaryValue: primaryValue ?? null,
    secondaryMetrics,
  };
}

export function computeOperationalSummary(
  rows: PlatformBreakdownRow[],
  totals: {
    totalPosted: number;
    totalQueued: number;
    totalFailed: number;
  },
) {
  const attempts = totals.totalPosted + totals.totalFailed;
  return {
    ...totals,
    successRate:
      attempts > 0
        ? Math.round((totals.totalPosted / attempts) * 1000) / 10
        : 100,
    platformCount: rows.length,
  };
}
