/**
 * Marketing HQ — shared types for the cross-platform marketing engine.
 * Keep this file type-only — no runtime logic. Runtime helpers live in
 * `platforms.ts` and the metrics collector.
 */

export type MarketingPlatform = "x" | "instagram" | "facebook" | "youtube";

export const ALL_PLATFORMS: MarketingPlatform[] = ["x", "instagram", "facebook", "youtube"];

export interface MarketingPost {
  id: string;
  campaign_id: string | null;
  platform: MarketingPlatform;
  source_post_id: string | null;
  persona_id: string | null;
  adapted_content: string;
  adapted_media_url: string | null;
  thumbnail_url: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  status: "queued" | "posting" | "posted" | "failed";
  scheduled_for: string | null;
  posted_at: string | null;
  impressions: number;
  likes: number;
  shares: number;
  comments: number;
  views: number;
  clicks: number;
  error_message: string | null;
  created_at: string;
}

export interface PlatformAccount {
  id: string;
  platform: MarketingPlatform;
  account_name: string;
  account_id: string;
  account_url: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  extra_config: string;
  is_active: boolean;
  last_posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyMetrics {
  id: string;
  platform: MarketingPlatform;
  date: string;
  total_impressions: number;
  total_likes: number;
  total_shares: number;
  total_comments: number;
  total_views: number;
  total_clicks: number;
  posts_published: number;
  follower_count: number;
  follower_growth: number;
  top_post_id: string | null;
  collected_at: string;
}

/**
 * Platform-specific posting constraints — character limits, media
 * preferences, hashtag conventions. Used by `content-adapter` to
 * generate platform-native posts and to enforce hard text-length caps.
 */
export const PLATFORM_SPECS: Record<
  MarketingPlatform,
  {
    maxTextLength: number;
    preferredAspectRatio: string;
    mediaTypes: string[];
    hashtagStyle: "inline" | "end" | "none";
    linkSupport: boolean;
  }
> = {
  x: {
    maxTextLength: 280,
    preferredAspectRatio: "16:9",
    mediaTypes: ["image", "video"],
    hashtagStyle: "end",
    linkSupport: true,
  },
  instagram: {
    maxTextLength: 2200,
    preferredAspectRatio: "1:1",
    mediaTypes: ["image", "video"],
    hashtagStyle: "end",
    linkSupport: false,
  },
  facebook: {
    maxTextLength: 63206,
    preferredAspectRatio: "16:9",
    mediaTypes: ["image", "video", "text"],
    hashtagStyle: "inline",
    linkSupport: true,
  },
  youtube: {
    maxTextLength: 5000,
    preferredAspectRatio: "16:9",
    mediaTypes: ["video"],
    hashtagStyle: "end",
    linkSupport: true,
  },
};

/**
 * Output of `adaptContentForPlatform` — the platform-native rewrite
 * plus metadata (extracted hashtags, CTA, image-gen prompt for the
 * thumbnail).
 */
export interface AdaptedContent {
  text: string;
  hashtags: string[];
  callToAction: string;
  thumbnailPrompt: string;
}
