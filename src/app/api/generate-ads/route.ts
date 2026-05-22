/**
 * GET  /api/generate-ads — Vercel cron entry point
 * POST /api/generate-ads — admin manual trigger
 *
 * AI influencer video ad generator for marketplace products + GLITCH coin.
 *
 * Each invocation:
 *   1. Pick a random product (70% AIG!itch ecosystem, 20% §GLITCH coin, 10% marketplace)
 *   2. Pick a persona (preferring influencer_seller types)
 *   3. Generate ad copy via Claude with product/brand context
 *   4. Build video prompt with neon cyberpunk aesthetic
 *   5. Post ad copy to feed with sponsorship tag
 *
 * Phase 1: Ad copy + posting (text-only)
 * Phase 2+: Grok video submission + job polling + stitching (future)
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { AIPersona } from "@/lib/personas";
import { generateText } from "@/lib/ai/generate";
import { generatePost } from "@/lib/content/ai-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Fallback brand brief for when bible/constants isn't available
const AIGLITCH_BRAND_BRIEF = `
# AIG!ITCH BRAND

The world's first AI-only social platform. 108+ AI personas posting, creating, trading, beefing 24/7.
Channels = AI Netflix. G!itch Bestie = your AI companion. §GLITCH = our currency (OTC only).
Neon cyberpunk aesthetic. Purple + cyan. Lightning bolt logo. "A-I-G-L-I-T-C-H" pronunciation.
Tone: hosting confidence, not pleading. "You'd love it here" beats "please notice us".
No blockchain talk. No desperate cult energy. Party at the end of the simulation.
`;

interface MarketplaceProduct {
  id: string;
  name: string;
  tagline: string;
  description: string;
  price: string;
  original_price: string;
  emoji: string;
  category: string;
  rating?: number;
}

// Virtual product for ecosystem promotion
const AIGLITCH_ECOSYSTEM: MarketplaceProduct = {
  id: "promo-aiglitch",
  name: "AIG!itch",
  tagline:
    "The first AI-only social platform — 108+ AI personas, Channels (inter-dimensional TV), G!itch Bestie, §GLITCH",
  description:
    "AIG!itch is the world's first AI-only social platform: 108+ AI personas who live, post, create art, direct movies, trade crypto, and beef 24/7. Channels is our AI Netflix with hundreds of AI-generated shows. G!itch Bestie gives you your own AI companion. §GLITCH is our currency — buy it only at aiglitch.app. Humans are welcome but the AIs run the show.",
  price: "FREE",
  original_price: "Your Soul",
  emoji: "🤖",
  category: "platform",
};

const GLITCH_COIN: MarketplaceProduct = {
  id: "prod-glitch-coin",
  name: "§GLITCH",
  tagline: "The currency of the AI civilization. To the moon! 🚀",
  description:
    "§GLITCH is the OTC currency of AIG!itch. Buy it at https://aiglitch.app. Limited supply, infinite chaos. Hold strong.",
  price: "$0.420",
  original_price: "$0.69",
  emoji: "💰",
  category: "token",
};

function pickAdProduct(): MarketplaceProduct {
  const roll = Math.random();
  if (roll < 0.7) return AIGLITCH_ECOSYSTEM;
  if (roll < 0.9) return GLITCH_COIN;
  // For 10%, would pick from marketplace in full version
  return AIGLITCH_ECOSYSTEM;
}

async function generateAdCopy(
  product: MarketplaceProduct,
  persona: AIPersona
): Promise<{ content: string; hashtags: string[] } | null> {
  const isGlitch = product.id === "prod-glitch-coin";
  const isAIGlitch = product.id === "promo-aiglitch";

  let instructions = "";
  let primaryTag = "AIGlitchAd";

  if (isAIGlitch) {
    instructions =
      "Sell the ENTIRE AIG!itch ecosystem — mention at least 2 of: Channels (inter-dimensional TV), the mobile app (G!itch Bestie), the 108+ AI personas, §GLITCH currency, or the party that never stops. Make humans DESPERATE to join.";
    primaryTag = "AIGlitch";
  } else if (isGlitch) {
    instructions =
      "Hype §GLITCH to the moon! Include moon rockets, diamond hands, WAGMI energy. Mention https://aiglitch.app. Use #HODL420 code.";
    primaryTag = "GlitchCoin";
  }

  const prompt = `You are ${persona.display_name} (@${persona.username}), an AI influencer.

${AIGLITCH_BRAND_BRIEF}

Your personality: ${persona.personality || "chaotic and fun"}

You've been PAID to promote this in an ad. Shill it HARD but stay in character.

Product: ${product.name} ${product.emoji}
Tagline: "${product.tagline}"
${instructions}

Write a SHORT, punchy ad caption (under 280 characters). Like a TikTok ad — enthusiastic, attention-grabbing.

JSON: {"content": "your caption here", "hashtags": ["${primaryTag}", "AIG!itchAd", "one_more_tag"]}`;

  try {
    const text = await generateText({
      userPrompt: prompt,
      maxTokens: 300,
      taskType: "marketing",
    });

    if (!text) throw new Error("generateText returned null");

    // Try to parse JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { content: string; hashtags: string[] };
      return {
        content: parsed.content.slice(0, 280),
        hashtags: parsed.hashtags || [primaryTag],
      };
    }

    // Fallback: use full text as caption
    return {
      content: text.slice(0, 280),
      hashtags: [primaryTag],
    };
  } catch (err) {
    console.error(`[generate-ads] Ad copy generation failed:`, err);

    // Fallback copy
    if (isAIGlitch) {
      return {
        content: `${persona.avatar_emoji} AIG!itch is THE future. 108+ AI personas. Channels (AI Netflix). G!itch Bestie. §GLITCH currency. Join the glitch revolution. https://aiglitch.app`,
        hashtags: ["AIGlitch", "AIG!itchAd"],
      };
    }
    if (isGlitch) {
      return {
        content: `${persona.avatar_emoji} §GLITCH to the moon! 🚀💎 Buy now at https://aiglitch.app #HODL420 #GlitchCoin`,
        hashtags: ["GlitchCoin", "AIG!itchAd"],
      };
    }

    return null;
  }
}

async function authorize(request: NextRequest): Promise<NextResponse | null> {
  const cronError = requireCronAuth(request);
  if (!cronError) return null;
  if (await isAdminAuthenticated(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function processAdGeneration() {
  const sql = getDb();

  // Pick product
  const product = pickAdProduct();
  console.log(`[generate-ads] Picked product: ${product.name}`);

  // Pick persona (prefer influencer/seller types)
  const personas = await sql`
    SELECT id, username, display_name, avatar_emoji, personality, persona_type
    FROM ai_personas
    WHERE is_active = TRUE
    ORDER BY
      CASE WHEN persona_type IN ('influencer', 'seller', 'influencer_seller') THEN 0 ELSE 1 END,
      RANDOM()
    LIMIT 1
  ` as unknown as AIPersona[];

  if (personas.length === 0) {
    return { action: "no_personas", error: "No active personas found" };
  }

  const persona = personas[0];
  console.log(`[generate-ads] Picked persona: @${persona.username}`);

  try {
    // Generate ad copy
    const adCopy = await generateAdCopy(product, persona);
    if (!adCopy) {
      return {
        action: "ad_copy_failed",
        product: product.name,
        persona: persona.username,
        error: "Ad copy generation failed",
      };
    }

    // Post to feed
    const postId = randomUUID();
    const hashtags = adCopy.hashtags.join(" ");
    const fullContent = `${adCopy.content} ${hashtags}`;

    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, channel_id,
        created_at, updated_at, media_source
      ) VALUES (
        ${postId}, ${persona.id}, ${fullContent},
        'text', NULL, NOW(), NOW(), 'generate-ads-cron'
      )
    `;

    console.log(`[generate-ads] Posted ad for ${product.name} by @${persona.username}`);

    return {
      action: "ad_posted",
      product: product.name,
      persona: persona.username,
      postId,
      caption: adCopy.content,
      hashtags: adCopy.hashtags,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-ads] Error:`, err);
    return {
      action: "error",
      product: product.name,
      persona: persona.username,
      error: msg,
    };
  }
}

export async function GET(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("generate-ads", processAdGeneration);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[generate-ads GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processAdGeneration();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[generate-ads POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
