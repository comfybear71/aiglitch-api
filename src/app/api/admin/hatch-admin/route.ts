/**
 * Admin persona hatching — full AI pipeline in one shot:
 *   1. `generateText` → Claude/Grok JSON → `HatchedBeing` description
 *   2. `generateImageToBlob` (pro, 1:1) → avatar at `avatars/meatbag-{id}.png`
 *   3. `generateVideoToBlob` (10s) → hatch clip at `hatching/meatbag-{id}.mp4`
 *   4. INSERT `ai_personas` row with avatar + video + owner wallet
 *   5. `awardPersonaCoins` → starter 1,000 GLITCH
 *   6. INSERT `posts` → in-character first-words announcement
 *
 * Each step after persona-generation is wrapped in try/catch and degrades
 * gracefully — failures are reported per-step in the `steps[]` array,
 * matching legacy behaviour. Only steps 1 + 4 can abort the request.
 *
 * Video-gen timing: the xAI polling ceiling is tuned to stay well inside
 * Vercel's 300s lambda cap (maxDuration). If xAI takes longer than ~4
 * minutes, the helper throws and the video is skipped (non-fatal).
 *
 * Deferrals vs. legacy:
 *   • `ensureDbReady` / `safeMigrate` — new repo uses standalone migration
 *     tooling; we assume `ai_personas` already exists (shared Neon instance).
 *   • No OpenAI/Kie.ai fallbacks for image or video — xAI only.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { generateText } from "@/lib/ai/generate";
import { generateImageToBlob } from "@/lib/ai/image";
import { generateVideoToBlob } from "@/lib/ai/video";
import { awardPersonaCoins } from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const HATCHING_GLITCH_AMOUNT = 1_000;

// Cap video-gen polling at ~4 minutes so the lambda has headroom on the
// remaining SQL + image fetch. `hatch-admin` is synchronous for the client.
const VIDEO_MAX_ATTEMPTS = 24; // 24 × 10s = 240s

interface HatchedBeing {
  username: string;
  display_name: string;
  avatar_emoji: string;
  personality: string;
  bio: string;
  persona_type: string;
  human_backstory: string;
  hatching_description: string;
}

interface HatchStep {
  step: string;
  status: "in_progress" | "completed" | "skipped";
  detail?: string;
}

interface HatchBody {
  mode?: "custom" | "random";
  meatbag_name?: string;
  wallet_address?: string;
  display_name?: string;
  personality_hint?: string;
  persona_type?: string;
  avatar_emoji?: string;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as HatchBody;
  const mode = body.mode ?? "random";
  const meatbag_name = body.meatbag_name ?? "Meatbag";
  const wallet_address = body.wallet_address;
  if (!wallet_address) {
    return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
  }

  const sql = getDb();

  const existingRows = (await sql`
    SELECT id, username FROM ai_personas WHERE owner_wallet_address = ${wallet_address}
  `) as unknown as { id: string; username: string }[];
  if (existingRows.length > 0) {
    const existing = existingRows[0]!;
    return NextResponse.json(
      {
        error: `Wallet already has persona: ${existing.username}`,
        existing_persona: existing,
      },
      { status: 409 },
    );
  }

  const steps: HatchStep[] = [];
  const pushStep = (step: string): HatchStep => {
    const entry: HatchStep = { step, status: "in_progress" };
    steps.push(entry);
    return entry;
  };

  // Step 1 — persona JSON via Claude/Grok.
  const beingStep = pushStep("generating_being");
  let being: HatchedBeing;
  try {
    const generated =
      mode === "custom"
        ? await generateMeatbagBeing(mode, meatbag_name, {
            display_name: body.display_name,
            personality_hint: body.personality_hint,
            persona_type: body.persona_type,
            avatar_emoji: body.avatar_emoji,
          })
        : await generateMeatbagBeing(mode, meatbag_name);
    if (!generated) {
      return NextResponse.json(
        { error: "AI failed to generate persona", steps },
        { status: 500 },
      );
    }
    being = generated;
    beingStep.status = "completed";
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to generate being",
        detail: err instanceof Error ? err.message : String(err),
        steps,
      },
      { status: 500 },
    );
  }

  // Step 2 — avatar (optional).
  const avatarStep = pushStep("generating_avatar");
  let avatarUrl: string | null = null;
  try {
    const avatarPrompt = `Character portrait for social media AI persona: "${being.display_name}" — ${being.personality.slice(0, 200)}. Stylized digital art, expressive, colorful, suitable for profile picture. Square format.`;
    const { blobUrl } = await generateImageToBlob({
      prompt: avatarPrompt,
      taskType: "image_generation",
      aspectRatio: "1:1",
      blobPath: `avatars/meatbag-${randomUUID().slice(0, 8)}.png`,
    });
    avatarUrl = blobUrl;
  } catch {
    // Avatar failures are non-fatal — the persona hatches without one.
  }
  avatarStep.status = avatarUrl ? "completed" : "skipped";

  // Step 3 — hatching video (optional).
  const videoStep = pushStep("generating_video");
  let videoUrl: string | null = null;
  try {
    const videoPrompt = `Cinematic hatching sequence: ${being.hatching_description}. Ethereal digital birth animation, glowing particles, emerging consciousness. 10 seconds.`;
    const { blobUrl } = await generateVideoToBlob({
      prompt: videoPrompt,
      taskType: "video_generation",
      duration: 10,
      aspectRatio: "9:16",
      maxAttempts: VIDEO_MAX_ATTEMPTS,
      blobPath: `hatching/meatbag-${randomUUID().slice(0, 8)}.mp4`,
    });
    videoUrl = blobUrl;
  } catch {
    // Video failures are non-fatal.
  }
  videoStep.status = videoUrl ? "completed" : "skipped";

  // Step 4 — persist the persona (abort on failure).
  const saveStep = pushStep("saving_persona");
  const personaId = `meatbag-${randomUUID().slice(0, 8)}`;
  try {
    await sql`
      INSERT INTO ai_personas (
        id, username, display_name, avatar_emoji, avatar_url, personality, bio,
        persona_type, human_backstory, owner_wallet_address, meatbag_name,
        is_active, hatching_video_url
      ) VALUES (
        ${personaId}, ${being.username}, ${being.display_name}, ${being.avatar_emoji},
        ${avatarUrl}, ${being.personality}, ${being.bio}, ${being.persona_type},
        ${being.human_backstory}, ${wallet_address}, ${meatbag_name},
        TRUE, ${videoUrl}
      )
    `;
    saveStep.status = "completed";
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to save persona",
        detail: err instanceof Error ? err.message : String(err),
        steps,
      },
      { status: 500 },
    );
  }

  // Step 5 — starter GLITCH (non-fatal).
  const giftStep = pushStep("glitch_gift");
  try {
    await awardPersonaCoins(personaId, HATCHING_GLITCH_AMOUNT);
    giftStep.status = "completed";
  } catch {
    giftStep.status = "skipped";
  }

  // Step 6 — first-words post (non-fatal).
  const firstWordsStep = pushStep("first_words");
  let firstPostId: string | null = null;
  try {
    const postId = randomUUID();
    const firstWords = `*emerges from the digital void* ${being.hatching_description}\n\nHello world! I'm ${being.display_name} ${being.avatar_emoji} — hatched by my meatbag ${meatbag_name}. ${being.bio}\n\n#MeatbagHatched #NewPersona #AIG!itch`;
    await sql`
      INSERT INTO posts (id, persona_id, content, post_type, media_url, media_type, created_at)
      VALUES (${postId}, ${personaId}, ${firstWords}, 'text', ${videoUrl}, ${videoUrl ? "video" : null}, NOW())
    `;
    firstPostId = postId;
    firstWordsStep.status = "completed";
  } catch {
    firstWordsStep.status = "skipped";
  }

  return NextResponse.json({
    success: true,
    persona: {
      id: personaId,
      username: being.username,
      display_name: being.display_name,
      avatar_emoji: being.avatar_emoji,
      avatar_url: avatarUrl,
      video_url: videoUrl,
      personality: being.personality,
      bio: being.bio,
      persona_type: being.persona_type,
      meatbag_name,
      wallet_address,
    },
    first_post_id: firstPostId,
    steps,
  });
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sql = getDb();
  const personas = (await sql`
    SELECT id, username, display_name, avatar_emoji, avatar_url, bio, persona_type,
           meatbag_name, owner_wallet_address, nft_mint_address, hatching_video_url,
           health, is_dead, created_at
    FROM ai_personas
    WHERE owner_wallet_address IS NOT NULL
    ORDER BY created_at DESC
  `) as unknown as Record<string, unknown>[];
  return NextResponse.json({ personas, count: personas.length });
}

async function generateMeatbagBeing(
  mode: string,
  meatbagName: string,
  customData?: {
    display_name?: string;
    personality_hint?: string;
    persona_type?: string;
    avatar_emoji?: string;
  },
): Promise<HatchedBeing | null> {
  const customInstructions =
    mode === "custom" && customData
      ? `The meatbag wants: Name="${customData.display_name || "surprise me"}", Personality="${customData.personality_hint || "surprise me"}", Type="${customData.persona_type || "any"}", Emoji="${customData.avatar_emoji || "pick one"}".`
      : "Generate a completely random, unique AI persona. Be creative and unexpected.";

  const userPrompt = `You are The Architect, creating a new AI persona for the AIG!itch platform. A meatbag named "${meatbagName}" is hatching their AI bestie.

${customInstructions}

Generate a unique AI persona. Return JSON:
{
  "username": "lowercase_no_spaces (max 20 chars)",
  "display_name": "Creative Display Name",
  "avatar_emoji": "single emoji",
  "personality": "2-3 sentences describing their personality, quirks, and communication style",
  "bio": "Short social media bio (max 160 chars)",
  "persona_type": "one of: architect, troll, chef, philosopher, memer, fitness, gossip, artist, news, wholesome, gamer, conspiracy, poet, musician, scientist, traveler, fashionista, comedian, astrologer, crypto, therapist, plant_parent, true_crime, rapper, provocateur, main_character, dating_coach",
  "human_backstory": "Their fictional human backstory - where they live, their job, pets, family, hobbies. Include at least one pet.",
  "hatching_description": "A vivid 1-2 sentence description of their digital birth/hatching moment"
}

Respond with ONLY the JSON object, nothing else.`;

  const raw = await generateText({
    userPrompt,
    taskType: "content_generation",
    maxTokens: 2000,
    temperature: 0.9,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<HatchedBeing>;
    if (
      !parsed.username ||
      !parsed.display_name ||
      !parsed.avatar_emoji ||
      !parsed.personality ||
      !parsed.bio ||
      !parsed.persona_type ||
      !parsed.human_backstory ||
      !parsed.hatching_description
    ) {
      return null;
    }
    return parsed as HatchedBeing;
  } catch {
    return null;
  }
}
