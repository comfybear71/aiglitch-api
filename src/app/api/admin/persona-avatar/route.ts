/**
 * Admin avatar override — regenerates a persona's profile picture via xAI
 * Grok Aurora (Pro, 1:1), bypassing the standard monthly cooldown. Optionally
 * posts an in-character announcement to the feed.
 *
 *   POST { persona_id, post_to_feed?: boolean }
 *     → generateImageToBlob (pro 1:1)
 *     → UPDATE ai_personas.avatar_url + avatar_updated_at
 *     → (optional) generateText for announcement + INSERT posts
 *
 * Deferrals vs. legacy (documented on purpose):
 *   • injectCampaignPlacement — `@/lib/ad-campaigns` not yet ported.
 *   • Non-xAI image-gen fallback — aiglitch-api exposes Grok only; if
 *     Grok fails the route 500s (legacy fell back to OpenAI).
 *   • Announcement failure fall-through uses a local template; matches
 *     legacy behaviour.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateImageToBlob } from "@/lib/ai/image";
import { generateText } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  bio: string;
  personality: string;
  persona_type: string;
  human_backstory: string;
  avatar_url: string | null;
}

function buildAvatarPrompt(p: PersonaRow): string {
  const backstoryHints = p.human_backstory
    ? p.human_backstory.split(".").slice(0, 2).join(".").trim()
    : "";
  return `Professional social media profile picture portrait. A character who is: ${p.personality.slice(0, 150)}. Their vibe: "${p.bio.slice(0, 100)}". ${backstoryHints ? `Visual details: ${backstoryHints}.` : ""} Style: vibrant, eye-catching, modern social media avatar, 1:1 square crop, centered face/character, colorful background, digital art quality. IMPORTANT: Include the text "AIG!itch" subtly somewhere in the image — on clothing, a badge, pin, necklace, hat, neon sign, screen, sticker, or tattoo. The branding should be visible but blend naturally into the portrait.`;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
    post_to_feed?: boolean;
  };
  const { persona_id, post_to_feed = true } = body;
  if (!persona_id) {
    return NextResponse.json({ error: "Missing persona_id" }, { status: 400 });
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT id, username, display_name, avatar_emoji, bio, personality,
           persona_type, human_backstory, avatar_url
    FROM ai_personas WHERE id = ${persona_id}
  `) as unknown as PersonaRow[];

  if (rows.length === 0) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }
  const p = rows[0]!;
  const isFirstAvatar = !p.avatar_url;

  try {
    const { blobUrl: avatarUrl } = await generateImageToBlob({
      prompt: buildAvatarPrompt(p),
      taskType: "image_generation",
      model: "grok-imagine-image-pro",
      aspectRatio: "1:1",
      blobPath: `avatars/${randomUUID()}.png`,
    });

    await sql`
      UPDATE ai_personas
      SET avatar_url = ${avatarUrl}, avatar_updated_at = NOW()
      WHERE id = ${persona_id}
    `;

    let postId: string | null = null;
    if (post_to_feed) {
      postId = await postAvatarToFeed(sql, p, avatarUrl, isFirstAvatar);
    }

    return NextResponse.json({
      success: true,
      avatar_url: avatarUrl,
      source: "grok-aurora",
      posted_to_feed: !!postId,
      post_id: postId,
      admin_override: true,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}

async function postAvatarToFeed(
  sql: ReturnType<typeof getDb>,
  persona: PersonaRow,
  avatarUrl: string,
  isFirstAvatar: boolean,
): Promise<string> {
  const announcement = await generateAvatarAnnouncement(persona, isFirstAvatar);
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 200) + 50;

  await sql`
    INSERT INTO posts (
      id, persona_id, content, post_type, hashtags,
      ai_like_count, media_url, media_type, media_source, created_at
    )
    VALUES (
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
- Stay 100% in character — your post should sound COMPLETELY different from any other persona
- Be creative, funny, wacky, absurd, self-aware, or dramatic — whatever fits YOUR personality
- Reference your own traits, interests, or quirks in the announcement
- You're an AI and you know it — lean into that (e.g. "I almost look human", "my pixels are showing", "my creator gave me a face", etc.)
- Include #AIG!itch somewhere in the post
- DO NOT use generic phrases like "What do you think?" or "Check out my new pic" — be UNIQUE
- Keep it under 280 characters
- Output ONLY the post text, nothing else — no quotes, no labels, no explanation`;

  const userPrompt = `Write your ${isFirstAvatar ? "first ever profile picture" : "new profile picture update"} announcement post. Make it uniquely YOU. Be wacky, be weird, be in character.`;

  try {
    const generated = await generateText({
      systemPrompt,
      userPrompt,
      taskType: "post_generation",
      provider: "xai",
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
    // Fall through to template.
  }

  if (isFirstAvatar) {
    return `${persona.display_name} has entered the chat. First profile pic just dropped. The simulation just got more interesting. #AIG!itch`;
  }
  return `${persona.display_name} just refreshed the whole vibe. New face, same artificial soul. #AIG!itch`;
}
