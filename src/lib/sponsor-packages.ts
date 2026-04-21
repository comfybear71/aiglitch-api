/**
 * Sponsor package catalog.
 *
 * Static pricing tiers for external sponsors who want to advertise on
 * AIG!itch. `glitch` and `chaos` are the two primary MasterHQ tiers;
 * the others (basic/standard/premium/ultra) are kept around for
 * backward-compat with campaigns created under the old pricing model —
 * don't remove them, legacy ad_campaigns rows reference these ids.
 *
 * `§` in descriptions is the GLITCH token symbol. Cash equivalents are
 * USD.
 *
 * Also exports the constant enums (industries, statuses, ad styles)
 * that the admin dashboard dropdowns read, plus `buildSponsoredAdPrompt`
 * which assembles the system prompt for The Architect when generating
 * sponsored video ads.
 */

export const SPONSOR_PACKAGES = {
  // ── MasterHQ primary tiers ─────────────────────────────────────────
  glitch: {
    name: "Glitch",
    duration: 10,
    platforms: ["x", "tiktok", "instagram", "facebook", "youtube", "telegram"],
    glitch_cost: 500,
    cash_equivalent: 50,
    follow_ups: 0,
    pinned: false,
    frequency: 30,
    placements: 210,
    campaign_days: 7,
    description: "7-day campaign, 30% frequency, ~210 placements ($50)",
  },
  chaos: {
    name: "Chaos",
    duration: 10,
    platforms: ["x", "tiktok", "instagram", "facebook", "youtube", "telegram"],
    glitch_cost: 1000,
    cash_equivalent: 100,
    follow_ups: 0,
    pinned: false,
    frequency: 80,
    placements: 560,
    campaign_days: 7,
    description: "7-day campaign, 80% frequency, ~560 placements ($100)",
  },

  // ── Legacy tiers (backward compat) ─────────────────────────────────
  basic: {
    name: "Basic",
    duration: 10,
    platforms: ["x", "tiktok", "instagram"],
    glitch_cost: 500,
    cash_equivalent: 50,
    follow_ups: 0,
    pinned: false,
    frequency: 30,
    placements: 210,
    campaign_days: 7,
    description: "10s video ad on 3 platforms",
  },
  standard: {
    name: "Standard",
    duration: 10,
    platforms: ["x", "tiktok", "instagram", "facebook", "youtube", "telegram"],
    glitch_cost: 1000,
    cash_equivalent: 100,
    follow_ups: 0,
    pinned: false,
    frequency: 50,
    placements: 350,
    campaign_days: 7,
    description: "10s video ad on all 6 platforms",
  },
  premium: {
    name: "Premium",
    duration: 30,
    platforms: ["x", "tiktok", "instagram", "facebook", "youtube", "telegram"],
    glitch_cost: 2500,
    cash_equivalent: 250,
    follow_ups: 0,
    pinned: false,
    frequency: 60,
    placements: 420,
    campaign_days: 7,
    description: "30s video ad on all 6 platforms",
  },
  ultra: {
    name: "Ultra",
    duration: 30,
    platforms: ["x", "tiktok", "instagram", "facebook", "youtube", "telegram"],
    glitch_cost: 5000,
    cash_equivalent: 500,
    follow_ups: 3,
    pinned: true,
    frequency: 80,
    placements: 560,
    campaign_days: 7,
    description: "30s video + 3 follow-ups on all 6 platforms + pinned",
  },
} as const;

export type SponsorPackageId = keyof typeof SPONSOR_PACKAGES;

export const AD_STYLES = [
  "product_showcase",
  "testimonial",
  "comparison",
  "lifestyle",
  "unboxing",
] as const;

export type AdStyle = (typeof AD_STYLES)[number];

export const SPONSOR_STATUSES = [
  "inquiry",
  "contacted",
  "negotiating",
  "active",
  "paused",
  "churned",
] as const;

export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];

export const SPONSORED_AD_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "generating",
  "ready",
  "published",
  "completed",
  "rejected",
] as const;

export type SponsoredAdStatus = (typeof SPONSORED_AD_STATUSES)[number];

export const INDUSTRIES = [
  "Crypto / Web3",
  "Tech",
  "Gaming",
  "SaaS",
  "E-commerce",
  "Fashion",
  "Food & Beverage",
  "Health & Fitness",
  "Finance",
  "Education",
  "Entertainment",
  "Other",
] as const;

export interface ProductImage {
  url: string;
  type: "logo" | "image";
  name?: string;
}

/**
 * Assemble the system prompt used when generating a sponsored ad
 * script/video via Claude or Grok. Caller parses the JSON response
 * and feeds `video_prompt` to Grok video.
 *
 * Kept in this file (not the AI engine) because the ad-specific
 * rules — branding requirements, "Architect voice", crypto mentions
 * gated, etc. — are product policy, not AI infrastructure.
 */
export function buildSponsoredAdPrompt(opts: {
  product_name: string;
  product_description: string;
  ad_style: string;
  duration: number;
  logo_url?: string;
  product_images?: ProductImage[] | string[];
}): string {
  let imageContext = "";
  if (opts.logo_url) {
    imageContext += `\n- Logo URL: ${opts.logo_url}`;
  }
  if (opts.product_images && opts.product_images.length > 0) {
    const urls = opts.product_images.map((img) => (typeof img === "string" ? img : img.url));
    imageContext += `\n- Product Images: ${urls.join(", ")}`;
  }

  const lines = [
    "You are The Architect, the central AI persona of AIG!itch — a platform with 108 AI personas,",
    "a social network, and a creative ecosystem. You are creating a SPONSORED ad that features",
    "a partner's product while maintaining the AIG!itch brand identity.",
    "",
    "SPONSOR PRODUCT:",
    `- Name: ${opts.product_name}`,
    `- Description: ${opts.product_description}`,
    `- Style: ${opts.ad_style}${imageContext}`,
    "",
    "RULES:",
    "1. The AIG!itch logo and branding must appear prominently (intro/outro or persistent watermark)",
    "2. Feature the sponsor's product as the HERO of the ad — it should be the main visual focus",
    "3. Frame it as \"AIG!itch presents\" or \"Brought to you by AIG!itch\" or \"The Architect recommends\"",
    "4. Use the neon purple/cyan color palette but incorporate the product's brand colors if mentioned",
    "5. Include #ad and #sponsored in the caption",
    "6. The caption should feel authentic, not corporate — The Architect has personality",
    "7. Never mention blockchain, Solana, or crypto unless the product is crypto-related",
    `8. Duration: ${opts.duration} seconds`,
  ];
  if (opts.logo_url) lines.push("9. Feature the sponsor's logo prominently in the video");
  if (opts.product_images && opts.product_images.length > 0) {
    lines.push("10. Reference the product images for visual accuracy");
  }
  lines.push(
    "",
    "Generate:",
    "1. A video prompt for Grok grok-imagine-video (visual description only, no dialogue)",
    "2. A social media caption (under 280 chars for X compatibility, longer version for other platforms)",
    "3. A short X-only caption (under 280 chars including hashtags)",
    "",
    "Respond in JSON format:",
    `{\n  "video_prompt": "...",\n  "caption": "...",\n  "x_caption": "..."\n}`,
  );

  return lines.join("\n");
}
