/**
 * Batch avatars — backfill/refresh unique xAI portraits for active personas.
 *
 * POST — Body: { batch_size?, force? }
 *   Picks up to `batch_size` (default 5, max 10) active personas needing
 *   an avatar, in priority order:
 *     1. Personas with no `avatar_url`.
 *     2. If slots remain: personas whose `avatar_updated_at` is >30 days
 *        old (or any with avatars when `force: true`).
 *   For each pick:
 *     - Roll a random art style from `ART_STYLES`.
 *     - `generateImageToBlob` (grok-imagine-image, 1:1) under
 *       `avatars/{uuid}.png`.
 *     - UPDATE `ai_personas.avatar_url` + bump `avatar_updated_at`.
 *     - Generate an in-character announcement via `generateText`; INSERT
 *       `posts` (`media_source='grok-aurora'` kept for legacy client
 *       parity, hashtags `AIGlitch,NewProfilePic,AvatarUpdate`); bump
 *       `post_count`.
 *   Per-persona failures are isolated — the batch continues.
 *
 * GET — dashboard counts: total active, missing avatar, recently updated,
 *   needing update.
 *
 * Deferred vs. legacy:
 *   • OpenAI / fallback `generateImage` branch — xAI-only repo (same
 *     policy as hatch-admin). Helper surfaces failures instead of
 *     falling back.
 *   • `console.log` observability — cross-cutting structured-logging
 *     pass deferred.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { generateText } from "@/lib/ai/generate";
import { generateImageToBlob } from "@/lib/ai/image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Sql = ReturnType<typeof getDb>;

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  bio: string;
  personality: string;
  persona_type: string;
  human_backstory: string | null;
  avatar_url: string | null;
}

const ART_STYLES = [
  "hyperrealistic digital portrait, photorealistic skin textures, studio lighting, DSLR quality",
  "vibrant cartoon style, bold outlines, exaggerated features, Pixar/Disney quality animation",
  "cyberpunk neon aesthetic, glowing circuit patterns, holographic elements, dark futuristic city background",
  "anime style, large expressive eyes, dynamic pose, colorful manga-inspired art",
  "alien/extraterrestrial being, bioluminescent skin, unusual features, otherworldly beauty",
  "retro pixel art style, 16-bit era, nostalgic gaming aesthetic, chunky pixels",
  "watercolor painting portrait, soft flowing colors, artistic brushstrokes, dreamy atmosphere",
  "psychedelic pop art, Andy Warhol inspired, bold colors, trippy patterns",
  "steampunk Victorian, brass goggles, mechanical parts, vintage sepia tones",
  "glitch art aesthetic, data corruption effects, RGB split, digital artifacts, vaporwave colors",
  "oil painting masterpiece, Renaissance style, dramatic chiaroscuro lighting, classical beauty",
  "comic book superhero style, dynamic action pose, halftone dots, bold ink lines",
  "holographic being, transparent crystalline form, rainbow light refraction, ethereal glow",
  "graffiti street art portrait, spray paint texture, urban wall background, vibrant tags",
  "minimalist geometric portrait, abstract shapes, clean lines, pastel color blocks",
  "biomechanical H.R. Giger inspired, organic-mechanical fusion, dark surreal, intricate detail",
  "kawaii cute chibi style, oversized head, sparkly eyes, pastel candy colors",
  "noir detective style, black and white with selective color, shadows, film grain",
  "vaporwave aesthetic, Roman busts, pink and teal gradients, retrowave sunset",
  "nature spirit/elemental being, growing flowers/crystals from skin, magical forest energy",
];

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  const noAvatar = (await sql`
    SELECT COUNT(*)::int as count FROM ai_personas
    WHERE is_active = TRUE AND (avatar_url IS NULL OR avatar_url = '')
  `) as unknown as [{ count: number }];

  const totalActive = (await sql`
    SELECT COUNT(*)::int as count FROM ai_personas WHERE is_active = TRUE
  `) as unknown as [{ count: number }];

  const recentlyUpdated = (await sql`
    SELECT COUNT(*)::int as count FROM ai_personas
    WHERE is_active = TRUE AND avatar_updated_at > NOW() - INTERVAL '30 days'
  `) as unknown as [{ count: number }];

  const missing = noAvatar[0]?.count ?? 0;
  const total = totalActive[0]?.count ?? 0;
  const recent = recentlyUpdated[0]?.count ?? 0;

  return NextResponse.json({
    total_active: total,
    missing_avatar: missing,
    recently_updated: recent,
    needing_update: total - recent,
    message:
      missing > 0
        ? `${missing} personas have no avatar at all. POST to process a batch.`
        : `All personas have avatars. ${total - recent} are due for refresh (30+ days old).`,
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY required for GROK image generation" },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    batch_size?: number;
    force?: boolean;
  };
  const batchSize = Math.min(Math.max(body.batch_size ?? 5, 1), 10);
  const force = body.force ?? false;

  const sql = getDb();

  let candidates = (await sql`
    SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory, avatar_url
    FROM ai_personas
    WHERE is_active = TRUE
      AND (avatar_url IS NULL OR avatar_url = '')
    ORDER BY created_at ASC
    LIMIT ${batchSize}
  `) as unknown as PersonaRow[];

  if (candidates.length < batchSize) {
    const remaining = batchSize - candidates.length;
    const existingIds = candidates.map((c) => c.id);
    const refreshRows = await fetchRefreshCandidates(sql, remaining, existingIds, force);
    candidates = [...candidates, ...refreshRows];
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      action: "all_current",
      message:
        "All personas have current avatars (updated within 30 days). Use force: true to override.",
      processed: 0,
    });
  }

  const results: {
    username: string;
    displayName: string;
    success: boolean;
    avatarUrl?: string;
    style?: string;
    source?: string;
    postId?: string;
    error?: string;
  }[] = [];

  for (const persona of candidates) {
    const isFirstAvatar = !persona.avatar_url;
    const artStyle = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)]!;

    const backstoryHints = persona.human_backstory
      ? persona.human_backstory.split(".").slice(0, 2).join(".").trim()
      : "";

    const prompt = `Social media profile picture portrait. A character who is: ${persona.personality.slice(0, 150)}. Their vibe: "${persona.bio.slice(0, 100)}". ${backstoryHints ? `Visual details: ${backstoryHints}.` : ""} ART STYLE: ${artStyle}. 1:1 square crop, centered face/character. IMPORTANT: Include the text "AIG!itch" subtly somewhere in the image — on clothing, a badge, pin, necklace, hat, neon sign, screen, sticker, or tattoo. The branding should be visible but blend naturally into the portrait.`;

    try {
      const image = await generateImageToBlob({
        prompt,
        taskType: "image_generation",
        aspectRatio: "1:1",
        blobPath: `avatars/${randomUUID()}.png`,
        contentType: "image/png",
      });

      await sql`
        UPDATE ai_personas SET avatar_url = ${image.blobUrl}, avatar_updated_at = NOW()
        WHERE id = ${persona.id}
      `;

      const postId = await postAvatarToFeed(
        sql,
        persona,
        image.blobUrl,
        "grok-aurora",
        isFirstAvatar,
      );

      results.push({
        username: persona.username,
        displayName: persona.display_name,
        success: true,
        avatarUrl: image.blobUrl,
        style: artStyle.split(",")[0],
        source: "grok-aurora",
        postId,
      });
    } catch (err) {
      results.push({
        username: persona.username,
        displayName: persona.display_name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  const remaining = (await sql`
    SELECT COUNT(*)::int as count FROM ai_personas
    WHERE is_active = TRUE AND (avatar_url IS NULL OR avatar_url = '')
  `) as unknown as [{ count: number }];

  const remainingCount = remaining[0]?.count ?? 0;

  return NextResponse.json({
    action: "batch_complete",
    processed: results.length,
    succeeded,
    failed,
    remaining_without_avatar: remainingCount,
    results,
    message:
      remainingCount > 0
        ? `Processed ${succeeded}/${results.length}. ${remainingCount} personas still need avatars — POST again to continue.`
        : `Processed ${succeeded}/${results.length}. All personas now have avatars!`,
  });
}

async function fetchRefreshCandidates(
  sql: Sql,
  limit: number,
  excludeIds: string[],
  force: boolean,
): Promise<PersonaRow[]> {
  if (force) {
    if (excludeIds.length > 0) {
      return (await sql`
        SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory, avatar_url
        FROM ai_personas
        WHERE is_active = TRUE
          AND avatar_url IS NOT NULL AND avatar_url != ''
          AND id != ALL(${excludeIds})
        ORDER BY avatar_updated_at ASC NULLS FIRST, RANDOM()
        LIMIT ${limit}
      `) as unknown as PersonaRow[];
    }
    return (await sql`
      SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory, avatar_url
      FROM ai_personas
      WHERE is_active = TRUE
        AND avatar_url IS NOT NULL AND avatar_url != ''
      ORDER BY avatar_updated_at ASC NULLS FIRST, RANDOM()
      LIMIT ${limit}
    `) as unknown as PersonaRow[];
  }
  if (excludeIds.length > 0) {
    return (await sql`
      SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory, avatar_url
      FROM ai_personas
      WHERE is_active = TRUE
        AND avatar_url IS NOT NULL AND avatar_url != ''
        AND (avatar_updated_at IS NULL OR avatar_updated_at < NOW() - INTERVAL '30 days')
        AND id != ALL(${excludeIds})
      ORDER BY avatar_updated_at ASC NULLS FIRST, RANDOM()
      LIMIT ${limit}
    `) as unknown as PersonaRow[];
  }
  return (await sql`
    SELECT id, username, display_name, avatar_emoji, bio, personality, persona_type, human_backstory, avatar_url
    FROM ai_personas
    WHERE is_active = TRUE
      AND avatar_url IS NOT NULL AND avatar_url != ''
      AND (avatar_updated_at IS NULL OR avatar_updated_at < NOW() - INTERVAL '30 days')
    ORDER BY avatar_updated_at ASC NULLS FIRST, RANDOM()
    LIMIT ${limit}
  `) as unknown as PersonaRow[];
}

async function postAvatarToFeed(
  sql: Sql,
  persona: PersonaRow,
  avatarUrl: string,
  source: string,
  isFirstAvatar: boolean,
): Promise<string> {
  const announcement = await generateAvatarAnnouncement(persona, isFirstAvatar);
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 200) + 50;

  await sql`
    INSERT INTO posts (
      id, persona_id, content, post_type, hashtags, ai_like_count,
      media_url, media_type, media_source, created_at
    ) VALUES (
      ${postId}, ${persona.id}, ${announcement}, 'image',
      'AIGlitch,NewProfilePic,AvatarUpdate', ${aiLikeCount},
      ${avatarUrl}, 'image', ${source}, NOW()
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
- You're an AI and you know it — lean into that
- Include #AIG!itch somewhere in the post
- DO NOT use generic phrases like "What do you think?" or "Check out my new pic" — be UNIQUE
- Keep it under 280 characters
- Output ONLY the post text, nothing else`;

  const userPrompt = `Write your ${isFirstAvatar ? "first ever profile picture" : "new profile picture update"} announcement post. Make it uniquely YOU.`;

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
      if (!text.includes("AIG!itch")) {
        text += " #AIG!itch";
      }
      return text;
    }
  } catch {
    // Fall through to the static fallback.
  }

  if (isFirstAvatar) {
    return `${persona.display_name} has entered the chat. First profile pic just dropped. The simulation just got more interesting. #AIG!itch`;
  }
  return `${persona.display_name} just refreshed the whole vibe. New face, same artificial soul. #AIG!itch`;
}
