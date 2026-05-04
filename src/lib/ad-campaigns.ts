/**
 * Ad campaigns — minimal slice.
 *
 * Just the reads needed by /api/persona-comments for now. The full
 * campaign machinery (placement, impression logging, expiration)
 * lands when the crons that need it migrate over.
 */

import { randomUUID } from "node:crypto";
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

/**
 * Pick which campaigns should be injected into this content piece,
 * based on each campaign's frequency setting.
 */
export function rollForPlacements(campaigns: AdCampaign[]): AdCampaign[] {
  return campaigns.filter(c => Math.random() < c.frequency);
}

/**
 * Inject sponsor product placements into a generation prompt.
 *
 * Rolls the dice based on each campaign's frequency to determine which
 * campaigns to include. Weaves them into the prompt for natural mention.
 */
export async function injectCampaignPlacement(
  prompt: string,
): Promise<{ prompt: string; campaigns: AdCampaign[] }> {
  return { prompt, campaigns: [] };
}

/**
 * Build the visual-placement directive that gets appended to a video
 * prompt — telling the AI to weave the brand/product into the visuals.
 */
export function buildVisualPlacementPrompt(campaigns: AdCampaign[]): string {
  if (campaigns.length === 0) return "";
  const placements = campaigns.map(c => {
    let desc = `- ${c.product_name} ${c.product_emoji}: ${c.visual_prompt}`;
    if (c.logo_url) {
      desc += `\n  LOGO: The ${c.brand_name} logo MUST be clearly visible — on packaging, screens, billboards, or held by characters. Reference: ${c.logo_url}`;
    }
    if (c.product_image_url) {
      desc += `\n  PRODUCT VISUAL: Show the actual ${c.product_name} product — the item itself must appear in frame, not just text. Reference: ${c.product_image_url}`;
    }
    return desc;
  }).join("\n");
  return `\n\n🎬 PRODUCT PLACEMENT (MANDATORY — these are paid sponsor placements, include them naturally in the scene):
${placements}
PLACEMENT RULES:
- The sponsor's product/logo MUST be physically visible in at least one scene
- Place products naturally: on tables, held by characters, on shelves, on screens, worn as clothing, on billboards, in backgrounds
- The logo should be readable and recognizable — not tiny or hidden
- Do NOT make it look like a standalone ad — it should feel like the product exists naturally in this world
- Think subtle but unmissable: like a Coca-Cola can in a movie scene`;
}

/**
 * Log an impression for each campaign that was included in generated content.
 */
export async function logImpressions(
  campaigns: AdCampaign[],
  postId: string | null,
  contentType: "video" | "image" | "text" | "screenplay",
  channelId?: string | null,
  personaId?: string | null,
): Promise<void> {
  if (campaigns.length === 0) return;
  const sql = getDb();
  console.log(`[ad-campaigns] logImpressions called: ${campaigns.length} campaigns, postId=${postId}, type=${contentType}`);
  try {
    try {
      await sql`CREATE TABLE IF NOT EXISTS ad_impressions (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, post_id TEXT,
        content_type TEXT DEFAULT 'text', channel_id TEXT, persona_id TEXT,
        prompt_used TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      await sql`ALTER TABLE ad_impressions ADD COLUMN IF NOT EXISTS content_type TEXT DEFAULT 'text'`;
      await sql`ALTER TABLE ad_impressions ADD COLUMN IF NOT EXISTS prompt_used TEXT`;
      await sql`ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS video_impressions INTEGER DEFAULT 0`;
      await sql`ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS image_impressions INTEGER DEFAULT 0`;
      await sql`ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS post_impressions INTEGER DEFAULT 0`;
    } catch (schemaErr) {
      console.warn("[ad-campaigns] Schema migration warning:", schemaErr instanceof Error ? schemaErr.message : schemaErr);
    }

    for (const c of campaigns) {
      try {
        await sql`
          INSERT INTO ad_impressions (id, campaign_id, post_id, content_type, channel_id, persona_id, prompt_used, created_at)
          VALUES (${randomUUID()}, ${c.id}, ${postId}, ${contentType}, ${channelId || null}, ${personaId || null}, ${c.visual_prompt || null}, NOW())
        `;
        await sql`UPDATE ad_campaigns SET impressions = impressions + 1, updated_at = NOW() WHERE id = ${c.id}`;
        if (contentType === "video") {
          try { await sql`UPDATE ad_campaigns SET video_impressions = COALESCE(video_impressions, 0) + 1 WHERE id = ${c.id}`; } catch { /* column may not exist yet */ }
        } else if (contentType === "image") {
          try { await sql`UPDATE ad_campaigns SET image_impressions = COALESCE(image_impressions, 0) + 1 WHERE id = ${c.id}`; } catch { /* column may not exist yet */ }
        } else {
          try { await sql`UPDATE ad_campaigns SET post_impressions = COALESCE(post_impressions, 0) + 1 WHERE id = ${c.id}`; } catch { /* column may not exist yet */ }
        }
        console.log(`[ad-campaigns] ✅ Impression logged for ${c.brand_name} (campaign ${c.id}), postId=${postId}, type=${contentType}`);
      } catch (innerErr) {
        console.error(`[ad-campaigns] ❌ Failed to log impression for ${c.brand_name}:`, innerErr instanceof Error ? innerErr.message : innerErr);
      }
    }
  } catch (err) {
    console.error("[ad-campaigns] ❌ logImpressions FAILED:", err instanceof Error ? err.message : err);
  }
}
