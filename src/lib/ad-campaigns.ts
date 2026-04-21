/**
 * Ad campaigns — minimal slice.
 *
 * Just the reads needed by /api/persona-comments for now. The full
 * campaign machinery (placement, impression logging, expiration)
 * lands when the crons that need it migrate over.
 */

import { getDb } from "@/lib/db";

export interface AdCampaign {
  id: string;
  brand_name: string;
  product_name: string;
  product_emoji: string;
  visual_prompt: string;
  text_prompt: string | null;
  logo_url: string | null;
  product_image_url: string | null;
  product_images: string[] | null;
  website_url: string | null;
  target_channels: string | null;
  target_persona_types: string | null;
  status: string;
  duration_days: number;
  price_glitch: number;
  frequency: number;
  grokify_scenes: number;
  grokify_mode: string;
  impressions: number;
  video_impressions: number;
  image_impressions: number;
  post_impressions: number;
  starts_at: string | null;
  expires_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * Active campaigns right now, optionally filtered by channel. A
 * campaign is "active" if status='active' and the current time is
 * within its starts_at/expires_at window. Catches query errors so a
 * missing `ad_campaigns` table in preview envs degrades to an empty
 * list rather than a 500.
 */
export async function getActiveCampaigns(
  channelId?: string | null,
): Promise<AdCampaign[]> {
  const sql = getDb();
  try {
    const campaigns = (await sql`
      SELECT * FROM ad_campaigns
      WHERE status = 'active'
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
    `) as unknown as AdCampaign[];

    if (!channelId) return campaigns;

    return campaigns.filter((c) => {
      if (!c.target_channels) return true;
      try {
        const targets = JSON.parse(c.target_channels) as string[];
        return targets.includes(channelId);
      } catch {
        return true;
      }
    });
  } catch (err) {
    console.warn("[ad-campaigns] fetch failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Flip every active campaign whose expires_at has passed to status='completed'.
 * Returns 0 on any SQL error (e.g. missing table on a fresh preview env) so
 * callers — typically the admin dashboard — can treat this as fire-and-forget.
 * No return count because Neon's UPDATE doesn't surface row counts cleanly;
 * admin UIs that need the number re-query afterwards.
 */
export async function expireCompletedCampaigns(): Promise<number> {
  const sql = getDb();
  try {
    const before = (await sql`
      SELECT COUNT(*)::int AS c FROM ad_campaigns
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
    `) as unknown as { c: number }[];
    const count = before[0]?.c ?? 0;

    if (count > 0) {
      await sql`
        UPDATE ad_campaigns
        SET status = 'completed', updated_at = NOW()
        WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
      `;
    }
    return count;
  } catch (err) {
    console.warn("[ad-campaigns] expire failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}
