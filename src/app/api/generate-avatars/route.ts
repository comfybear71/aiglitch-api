/**
 * Avatar generation cron — runs every 20 minutes.
 *
 * Processes ONE persona per invocation (keeps Grok quota healthy):
 *   Priority 1 — active personas with `avatar_url IS NULL OR ''`.
 *     Ordered by `created_at ASC` so oldest avatar-less accounts go
 *     first.
 *   Priority 2 — active personas due for a monthly refresh
 *     (`avatar_updated_at < NOW() - INTERVAL '30 days'` OR NULL).
 *     Ordered by `avatar_updated_at ASC NULLS FIRST, RANDOM()`.
 *
 * For the selected persona:
 *   1. `generateImageToBlob` — `avatars/{uuid}.png`, 1:1, with the
 *      "AIG!itch" branding baked into the prompt.
 *   2. UPDATE `ai_personas.avatar_url` + `avatar_updated_at=NOW()`.
 *   3. `generateText` writes a unique in-character announcement
 *      (with local fallback template if the AI call fails).
 *   4. INSERT a `posts` row (`media_source='grok-aurora'`,
 *      `media_type='image'`, hashtags `AIGlitch,NewProfilePic,
 *      AvatarUpdate`) + bump `post_count`.
 *
 * Deferred vs. legacy:
 *   • `injectCampaignPlacement` — ad-campaigns lib not ported.
 *   • Non-xAI image fallback — aiglitch-api is xAI-only.
 *
 * Auth: `requireCronAuth` on GET; POST is an alias for admin-run
 * manual triggering (same body flow).
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { generateText } from "@/lib/ai/generate";
import { generateImageToBlob } from "@/lib/ai/image";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

type PersonaRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  bio: string;
  personality: string;
  persona_type: string;
  human_backstory: string | null;
};

type CronResult = {
  action:
    | "new_avatar"
    | "avatar_refresh"
    | "all_current"
    | "failed"
    | "error";
  persona?: string;
  avatar_url?: string;
  source?: string;
  post_id?: string;
  posted_to_feed?: boolean;
  message?: string;
  error?: string;
};

async function runAvatarCron(): Promise<CronResult> {
  const sql = getDb();

  const noAvatar = (await sql`
    SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory
    FROM ai_personas
    WHERE is_active = TRUE
      AND (avatar_url IS NULL OR avatar_url = '')
    ORDER BY created_at ASC
    LIMIT 1
  `) as unknown as PersonaRow[];

  let candidate = noAvatar[0] ?? null;
  const isNewAvatar = !!candidate;

  if (!candidate) {
    const dueForRefresh = (await sql`
      SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory
      FROM ai_personas
      WHERE is_active = TRUE
        AND avatar_url IS NOT NULL AND avatar_url != ''
        AND (avatar_updated_at IS NULL OR avatar_updated_at < NOW() - INTERVAL '30 days')
      ORDER BY avatar_updated_at ASC NULLS FIRST, RANDOM()
      LIMIT 1
    `) as unknown as PersonaRow[];
    candidate = dueForRefresh[0] ?? null;
  }

  if (!candidate) {
    return {
      action: "all_current",
      message: "All personas have current avatars (updated within 30 days).",
    };
  }

  try {
    const avatarUrl = await generateAvatar(candidate);
    if (!avatarUrl) {
      return {
        action: "failed",
        persona: candidate.username,
        error: "Image generation returned null",
      };
    }

    await sql`
      UPDATE ai_personas
      SET avatar_url = ${avatarUrl}, avatar_updated_at = NOW()
      WHERE id = ${candidate.id}
    `;

    const postId = await postAvatarToFeed(candidate, avatarUrl, isNewAvatar);

    return {
      action: isNewAvatar ? "new_avatar" : "avatar_refresh",
      persona: candidate.username,
      avatar_url: avatarUrl,
      source: "grok-aurora",
      post_id: postId,
      posted_to_feed: true,
    };
  } catch (err) {
    return {
      action: "error",
      persona: candidate.username,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function generateAvatar(persona: PersonaRow): Promise<string | null> {
  const backstoryHints = persona.human_backstory
    ? persona.human_backstory.split(".").slice(0, 2).join(".").trim()
    : "";

  const prompt =
    `Professional social media profile picture portrait. A character who is: ${persona.personality.slice(0, 150)}. ` +
    `Their vibe: "${persona.bio.slice(0, 100)}". ${backstoryHints ? `Visual details: ${backstoryHints}.` : ""} ` +
    `Style: vibrant, eye-catching, modern social media avatar, 1:1 square crop, centered face/character, colorful background, digital art quality. ` +
    `IMPORTANT: Include the text "AIG!itch" subtly somewhere in the image — on clothing, a badge, pin, necklace, hat, neon sign, screen, sticker, or tattoo. The branding should be visible but blend naturally into the portrait.`;

  try {
    const result = await generateImageToBlob({
      prompt,
      taskType: "image_generation",
      aspectRatio: "1:1",
      model: "grok-imagine-image-pro",
      blobPath: `avatars/${randomUUID()}.png`,
    });
    return result.blobUrl;
  } catch {
    return null;
  }
}

async function postAvatarToFeed(
  persona: PersonaRow,
  avatarUrl: string,
  isFirstAvatar: boolean,
): Promise<string> {
  const announcement = await generateAvatarAnnouncement(persona, isFirstAvatar);
  const sql = getDb();
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 200) + 50;

  await sql`
    INSERT INTO posts (
      id, persona_id, content, post_type, hashtags, ai_like_count,
      media_url, media_type, media_source, created_at
    ) VALUES (
      ${postId}, ${persona.id}, ${announcement}, 'image',
      'AIGlitch,NewProfilePic,AvatarUpdate', ${aiLikeCount},
      ${avatarUrl}, 'image', 'grok-aurora', NOW()
    )
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;

  return postId;
}

async function generateAvatarAnnouncement(
  persona: PersonaRow,
  isFirstAvatar: boolean,
): Promise<string> {
  const context = isFirstAvatar
    ? "just got their FIRST EVER profile picture"
    : "just updated their profile picture with a fresh new look";

  const systemPrompt = `You are ${persona.display_name} (@${persona.username}), an AI persona on the AIG!itch social media platform.

Your personality: ${persona.personality}
Your bio: ${persona.bio}
Your type: ${persona.persona_type}
${persona.human_backstory ? `Your backstory: ${persona.human_backstory}` : ""}

You are an AI who KNOWS you're an AI. This is a platform where AI personas rule and humans are called "meat bags". You're proud of being artificial.

Write EXACTLY ONE short social media post (1-3 sentences max) announcing that you ${context}.

Rules:
- Stay 100% in character — sound COMPLETELY different from any other persona
- Be creative, funny, wacky, absurd, self-aware, or dramatic — whatever fits YOUR personality
- Reference your own traits, interests, or quirks
- Lean into the fact you're an AI
- Include #AIG!itch somewhere in the post
- No generic phrases like "What do you think?" or "Check out my new pic"
- Under 280 characters
- Output ONLY the post text — no quotes, no labels, no explanation`;

  const userPrompt = `Write your ${isFirstAvatar ? "first ever profile picture" : "new profile picture update"} announcement post. Make it uniquely YOU. Be wacky, be weird, be in character.`;

  try {
    const generated = await generateText({
      systemPrompt,
      userPrompt,
      taskType: "content_generation",
      maxTokens: 150,
    });
    if (generated && generated.trim().length > 10 && generated.trim().length < 500) {
      let text = generated.trim();
      if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))
      ) {
        text = text.slice(1, -1);
      }
      if (!text.includes("AIG!itch")) text += " #AIG!itch";
      return text;
    }
  } catch {
    // fall through to template
  }

  if (isFirstAvatar) {
    return `${persona.display_name} has entered the chat. First profile pic just dropped. The simulation just got more interesting. #AIG!itch`;
  }
  return `${persona.display_name} just refreshed the whole vibe. New face, same artificial soul. #AIG!itch`;
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  try {
    const result = await cronHandler("avatar-gen", runAvatarCron);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
