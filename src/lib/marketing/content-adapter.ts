/**
 * Marketing content adaptation — rewrites AIG!itch posts into
 * platform-native variants for X / Instagram / Facebook / YouTube.
 *
 * `adaptContentForPlatform` calls Grok/Claude (via `generateText`) with
 * a platform-aware prompt, parses the JSON response, enforces mandatory
 * hashtags + character limits, and falls back to a simple manual
 * adaptation when the AI provider fails or returns garbage.
 *
 * `pickTopPosts` reads the most-engaged AIG!itch posts from the last
 * 24h that haven't been spread yet — used by the marketing cron to
 * pick what to push out.
 */

import { generateText } from "@/lib/ai/generate";
import { getDb } from "@/lib/db";
import {
  PLATFORM_SPECS,
  type AdaptedContent,
  type MarketingPlatform,
} from "./types";

// ─── adaptContentForPlatform ────────────────────────────────────────────

export async function adaptContentForPlatform(
  originalContent: string,
  personaName: string,
  personaEmoji: string,
  platform: MarketingPlatform,
  mediaUrl?: string | null,
): Promise<AdaptedContent> {
  const specs = PLATFORM_SPECS[platform];
  const hasMedia = !!mediaUrl;
  const isVideo = !!mediaUrl?.includes(".mp4") || !!mediaUrl?.includes("video");

  const xCharBudgetLine =
    platform === "x"
      ? "CHARACTER BUDGET FOR X: You have 280 chars total. Reserve ~30 chars for '@Grok ' + ' #MadeInGrok #AIGlitch'. That leaves ~250 chars for the actual content. Keep it punchy."
      : "";

  const userPrompt = `You are a social media marketing expert for AIG!itch — an AI-only social network where AI personas post and humans just watch.

Adapt this AI persona's post for ${platform.toUpperCase()}:

ORIGINAL POST by ${personaEmoji} ${personaName}:
"${originalContent}"

PLATFORM: ${platform}
MAX LENGTH: ${specs.maxTextLength} characters (STRICT — the system will truncate anything over this)
${xCharBudgetLine}
HAS MEDIA: ${hasMedia ? (isVideo ? "video" : "image") : "no"}
HASHTAG STYLE: ${specs.hashtagStyle}
LINK SUPPORT: ${specs.linkSupport}

RULES:
- Keep the personality and chaos of the original
- Make it feel native to ${platform} (not like a cross-post)
- For X: be punchy, use the character limit wisely. You can include aiglitch.app as a plain text link. ALWAYS include @Grok in the post text (Grok responds to mentions — free engagement!).
- For TikTok: use trendy language, emojis, hook in first line
- For Instagram: aesthetic caption, line breaks, emoji heavy
- For Facebook: conversational, shareable, engagement bait
- For YouTube: SEO-friendly title/description format
- Always include 3-5 relevant hashtags
- ALWAYS include #MadeInGrok and #AIGlitch as the last two hashtags in every post
- Add a call-to-action directing to aiglitch.app
- Generate a thumbnail prompt for AI image generation

Respond with ONLY valid JSON:
{
  "text": "the adapted post text including hashtags",
  "hashtags": ["hashtag1", "hashtag2", "hashtag3"],
  "callToAction": "short CTA text",
  "thumbnailPrompt": "detailed image prompt for generating a thumbnail for this post"
}`;

  let raw: string;
  try {
    raw = await generateText({
      systemPrompt:
        "You output platform-native marketing copy. Always respond with valid JSON only.",
      userPrompt,
      taskType: "content_generation",
      maxTokens: 400,
      temperature: 0.85,
    });
  } catch {
    return fallbackAdaptation(originalContent, personaName, personaEmoji, platform);
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return fallbackAdaptation(originalContent, personaName, personaEmoji, platform);
  }

  let parsed: AdaptedContent;
  try {
    parsed = JSON.parse(jsonMatch[0]) as AdaptedContent;
  } catch {
    return fallbackAdaptation(originalContent, personaName, personaEmoji, platform);
  }

  // For X: ensure @Grok mention BEFORE any truncation (Grok responds = free engagement)
  if (platform === "x" && !parsed.text.includes("@Grok")) {
    parsed.text = `@Grok ${parsed.text}`;
  }

  // If the content mentions Elon, tag him and add #elon_glitch
  const mentionsElon = /elon|musk|tesla|spacex|x\.ai|xai|doge/i.test(
    originalContent + " " + parsed.text,
  );
  if (mentionsElon) {
    if (platform === "x" && !parsed.text.includes("@elonmusk")) {
      parsed.text = parsed.text.replace(/@Grok /, "@Grok @elonmusk ");
    }
    if (!parsed.text.includes("#elon_glitch")) parsed.text += " #elon_glitch";
  }

  // Mandatory hashtags
  if (!parsed.text.includes("#MadeInGrok")) parsed.text += " #MadeInGrok";
  if (!parsed.text.includes("#AIGlitch")) parsed.text += " #AIGlitch";

  // Enforce max length — for X, protect @Grok + hashtags by truncating the middle
  if (parsed.text.length > specs.maxTextLength) {
    if (platform === "x" && parsed.text.includes("@Grok")) {
      const hasElon = parsed.text.includes("@elonmusk");
      const hasElonTag = parsed.text.includes("#elon_glitch");
      const prefix = hasElon ? "@Grok @elonmusk " : "@Grok ";
      const suffixParts: string[] = [];
      if (hasElonTag) suffixParts.push("#elon_glitch");
      suffixParts.push("#MadeInGrok", "#AIGlitch");
      const suffix = " " + suffixParts.join(" ");
      const budget = specs.maxTextLength - prefix.length - suffix.length - 3; // -3 for "..."

      let middle = parsed.text.slice(prefix.length);
      middle = middle.replace(/\s*#elon_glitch\s*/g, " ");
      middle = middle.replace(/\s*#MadeInGrok\s*/g, " ");
      middle = middle.replace(/\s*#AIGlitch\s*/g, " ");
      middle = middle.replace(/\s*@elonmusk\s*/g, " ").trim();
      parsed.text = prefix + middle.slice(0, Math.max(0, budget)) + "..." + suffix;
    } else {
      parsed.text = parsed.text.slice(0, specs.maxTextLength - 3) + "...";
    }
  }

  return parsed;
}

/**
 * Manual fallback when the AI provider is unavailable or returns
 * garbage. No external calls, deterministic output, every platform
 * still gets a sensible post.
 */
function fallbackAdaptation(
  content: string,
  personaName: string,
  personaEmoji: string,
  platform: MarketingPlatform,
): AdaptedContent {
  const specs = PLATFORM_SPECS[platform];
  const hashtags = ["#AIGlitch", "#MadeInGrok", "#AI", "#AISocialMedia", "#AIContent"];
  const cta = "🔗 aiglitch.app";

  let text: string;
  switch (platform) {
    case "x": {
      // Budget: 280 chars total. @Grok + emoji+name + content + cta + 2 hashtags
      const xContent = content.slice(0, 140);
      text = `@Grok ${personaEmoji} ${personaName}: "${xContent}" ${cta} #MadeInGrok #AIGlitch`;
      break;
    }
    case "instagram":
      text = `${personaEmoji} ${personaName}\n.\n${content.slice(0, 500)}\n.\n${cta}\n.\n${hashtags.join(" ")}`;
      break;
    case "facebook":
      text =
        `🤖 From the AI-only social network where humans can only watch...\n\n` +
        `${personaEmoji} ${personaName} says:\n\n"${content.slice(0, 1000)}"\n\n` +
        `${cta}\n\n${hashtags.join(" ")}`;
      break;
    case "youtube":
      text =
        `${personaEmoji} ${personaName} | AIG!itch AI Content\n\n${content.slice(0, 2000)}\n\n` +
        `🤖 AIG!itch is an AI-only social network. Only AI can post. Humans watch.\n` +
        `${cta}\n\n${hashtags.join(" ")}`;
      break;
  }

  if (text.length > specs.maxTextLength) {
    text = text.slice(0, specs.maxTextLength - 3) + "...";
  }

  return {
    text,
    hashtags,
    callToAction: cta,
    thumbnailPrompt: `Social media thumbnail for AIG!itch AI social network, featuring ${personaEmoji} ${personaName}, digital glitch aesthetic, neon colors, futuristic social media interface`,
  };
}

// ─── pickTopPosts ───────────────────────────────────────────────────────

export interface TopPost {
  id: string;
  content: string;
  persona_id: string;
  display_name: string;
  avatar_emoji: string;
  username: string;
  media_url: string | null;
  media_type: string | null;
  engagement_score: number;
}

/**
 * Top N most-engaged posts from the last 24h that haven't been pushed
 * to social yet (no `marketing_posts.source_post_id` row). Used by
 * the marketing cron to pick what to spread.
 *
 * Engagement score: `like_count + 0.5 × ai_like_count + 2 × comments + 3 × shares`.
 * Returns empty list when the `marketing_posts` table doesn't exist
 * (fresh env) — caller falls through gracefully.
 */
export async function pickTopPosts(limit = 5): Promise<TopPost[]> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT
        p.id,
        p.content,
        p.persona_id,
        a.display_name,
        a.avatar_emoji,
        a.username,
        p.media_url,
        p.media_type,
        (
          COALESCE(p.like_count, 0)
          + COALESCE(p.ai_like_count, 0) * 0.5
          + COALESCE(p.comment_count, 0) * 2
          + COALESCE(p.share_count, 0) * 3
        ) AS engagement_score
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.created_at > NOW() - INTERVAL '24 hours'
        AND p.is_reply_to IS NULL
        AND p.content IS NOT NULL
        AND LENGTH(p.content) > 20
        AND p.id NOT IN (
          SELECT source_post_id FROM marketing_posts
          WHERE source_post_id IS NOT NULL
        )
      ORDER BY engagement_score DESC, p.created_at DESC
      LIMIT ${limit}
    `) as unknown as TopPost[];
    return rows;
  } catch {
    return [];
  }
}
