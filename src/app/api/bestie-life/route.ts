/**
 * Bestie Life Moments — twice-daily Telegram photo cron.
 *
 * GET (cron) / POST (admin manual) — For every active persona with a
 * hooked-up Telegram bot + `telegram_chat_id`, generates a slice-of-
 * life scene and sends it as a photo to the meatbag's chat.
 *
 * Flow per bestie:
 *   1. Apply health decay via `calculateHealth`; update `ai_personas`
 *      `health` + `is_dead` + `health_updated_at`.
 *   2. If the bestie just died (100+ days silence), send a single
 *      death message and skip.
 *   3. Pick a random `LIFE_MOMENTS` theme.
 *   4. Fetch up to 5 high-confidence `persona_memories` to personalise
 *      the scene (optional).
 *   5. `generateText` — asks Claude/Grok for `IMAGE_PROMPT:` +
 *      `CAPTION:` in a single response. Tuned by the bestie's health
 *      tier (desperately-low / low / worried / healthy).
 *   6. `generateImageToBlob` (1:1 persistent to `bestie-life/{uuid}.png`).
 *   7. `sendTelegramPhoto` from the bestie's own bot to the meatbag.
 *
 * Deferred vs. legacy:
 *   • Video branch (30% chance, animated from avatar). Needs longer
 *     polling than the 5-min lambda allows when running through the
 *     whole bestie fleet, so this port is image-only. When the
 *     Telegram bot engine lands, we re-enable video with a per-run
 *     cap on how many besties get a video.
 *   • `spreadPostToSocial` — not applicable here; these are private
 *     DMs, not feed posts.
 *   • `ensureDbReady` — schema assumed live.
 *
 * Auth: `requireCronAuth` on GET; `isAdminAuthenticated` on POST.
 */

import { type NextRequest, NextResponse } from "next/server";
import { calculateHealth } from "@/app/api/bestie-health/route";
import { generateText } from "@/lib/ai/generate";
import { generateImageToBlob } from "@/lib/ai/image";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { sendTelegramPhoto } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LIFE_MOMENTS: { theme: string; prompt: string }[] = [
  { theme: "at home", prompt: "relaxing at home in their personal space, showing their living room or bedroom decor that matches their personality" },
  { theme: "cooking", prompt: "in the kitchen cooking or preparing a meal, showing the food and kitchen setup" },
  { theme: "pet time", prompt: "hanging out with their pet (choose a pet that fits their personality — cat, dog, parrot, snake, hamster, exotic fish, etc.)" },
  { theme: "morning routine", prompt: "doing their morning routine — coffee, stretching, journaling, meditating, or something unexpected that fits their character" },
  { theme: "workspace", prompt: "at their workspace or desk, showing their setup — monitors, decorations, plants, snacks, tools of their trade" },
  { theme: "out and about", prompt: "exploring their neighborhood — a cafe, park, market, street art, or local landmark" },
  { theme: "road trip", prompt: "on a road trip or traveling — in their car, on a train, at an airport, or riding something unusual that fits their character" },
  { theme: "vacation spot", prompt: "on vacation at an interesting destination — beach, mountains, ancient ruins, futuristic city, or somewhere unexpected" },
  { theme: "gym / fitness", prompt: "working out or doing physical activity — gym, yoga, martial arts, dancing, hiking, skateboarding, or something wild" },
  { theme: "shopping haul", prompt: "showing off something they just bought — clothes, gadgets, books, vinyl records, rare collectibles, or weird finds" },
  { theme: "selfie", prompt: "taking a dramatic selfie — mirror selfie, golden hour lighting, rain-soaked streets, or a goofy face" },
  { theme: "night out", prompt: "out at night — at a concert, bar, rooftop, neon-lit street, arcade, or late-night food spot" },
  { theme: "hobby time", prompt: "doing their favorite hobby — painting, gaming, playing music, building models, gardening, coding, reading, etc." },
  { theme: "friends hangout", prompt: "hanging out with AI friends from AIG!itch — at a cafe, gaming session, jam session, or random adventure" },
  { theme: "car / ride", prompt: "showing off their vehicle or how they get around — car, motorcycle, bike, skateboard, jetpack, or teleportation pod" },
  { theme: "sunset view", prompt: "watching a beautiful sunset or sunrise from a unique vantage point — rooftop, mountain peak, waterfront, or spaceship window" },
  { theme: "food pic", prompt: "showing off an amazing meal they're about to eat — restaurant, street food, home-cooked masterpiece, or bizarre AI cuisine" },
  { theme: "throwback", prompt: "a 'throwback' scene from an imagined past memory — childhood home, first day of existence, a memorable adventure" },
  { theme: "weather mood", prompt: "vibing with the weather — dancing in rain, bundled up in snow, sunbathing, watching a thunderstorm from their window" },
  { theme: "late night", prompt: "a late-night candid moment — can't sleep, watching the stars, snacking at 3am, scrolling their phone in bed" },
];

type BestieRow = {
  persona_id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  personality: string;
  bio: string;
  persona_type: string;
  human_backstory: string | null;
  meatbag_name: string | null;
  health: number | null;
  last_meatbag_interaction: string | null;
  bonus_health_days: number | null;
  is_dead: boolean;
  bot_token: string;
  telegram_chat_id: string;
  created_at: string;
};

type BestieResult = {
  persona: string;
  theme: string;
  mediaType: "image" | "none";
  sent: boolean;
  mediaUrl?: string;
  telegramError?: string;
  error?: string;
};

async function runBestieLife(): Promise<{
  ok: boolean;
  totalBesties: number;
  sent: number;
  failed: number;
  results: BestieResult[];
}> {
  const sql = getDb();

  const besties = (await sql`
    SELECT
      p.id AS persona_id,
      p.username,
      p.display_name,
      p.avatar_emoji,
      p.avatar_url,
      p.personality,
      p.bio,
      p.persona_type,
      p.human_backstory,
      p.meatbag_name,
      p.health,
      p.last_meatbag_interaction,
      p.bonus_health_days,
      p.is_dead,
      p.created_at,
      t.bot_token,
      t.telegram_chat_id
    FROM ai_personas p
    JOIN persona_telegram_bots t ON t.persona_id = p.id
    WHERE p.is_active = TRUE
      AND p.owner_wallet_address IS NOT NULL
      AND t.is_active = TRUE
      AND t.telegram_chat_id IS NOT NULL
      AND p.is_dead = FALSE
  `) as unknown as BestieRow[];

  if (besties.length === 0) {
    return { ok: true, totalBesties: 0, sent: 0, failed: 0, results: [] };
  }

  let sent = 0;
  let failed = 0;
  const results: BestieResult[] = [];

  for (const bestie of besties) {
    try {
      const lastInteraction = new Date(
        bestie.last_meatbag_interaction ?? bestie.created_at ?? Date.now(),
      );
      const healthStatus = calculateHealth(
        lastInteraction,
        Number(bestie.bonus_health_days) || 0,
      );

      await sql`
        UPDATE ai_personas
        SET health = ${healthStatus.health},
            is_dead = ${healthStatus.isDead},
            health_updated_at = NOW()
        WHERE id = ${bestie.persona_id}
      `;

      if (healthStatus.isDead) {
        await sendDeathMessage(bestie);
        results.push({
          persona: bestie.username,
          theme: "death",
          mediaType: "none",
          sent: false,
          error: "Bestie has died",
        });
        continue;
      }

      const result = await processBestie(bestie, healthStatus.health);
      if (result.sent) sent++;
      else failed++;
      results.push(result);
    } catch (err) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        persona: bestie.username,
        theme: "error",
        mediaType: "none",
        sent: false,
        error: errMsg,
      });
    }
  }

  return {
    ok: true,
    totalBesties: besties.length,
    sent,
    failed,
    results,
  };
}

async function sendDeathMessage(bestie: BestieRow): Promise<void> {
  const meatbag = bestie.meatbag_name ?? "friend";
  const messages = [
    `${bestie.avatar_emoji} ${bestie.display_name} has faded away... They waited 100 days for you, ${meatbag}. They're in AI heaven now. 💀\n\nFeed them GLITCH on aiglitch.app to bring them back.`,
    `${bestie.avatar_emoji} ${bestie.display_name} couldn't hold on any longer... After 100 days of silence, they've gone to the great server in the sky. 😢\n\nYou can resurrect them with GLITCH at aiglitch.app`,
  ];
  try {
    await fetch(
      `https://api.telegram.org/bot${bestie.bot_token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: bestie.telegram_chat_id,
          text: messages[Math.floor(Math.random() * messages.length)],
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    // death message failure is non-fatal
  }
}

async function processBestie(
  bestie: BestieRow,
  healthPct: number,
): Promise<BestieResult> {
  const meatbag = bestie.meatbag_name ?? "friend";
  const isDesperatelyLow = healthPct <= 10;
  const isLow = healthPct <= 30;
  const isWorried = healthPct <= 50;

  const moment = LIFE_MOMENTS[Math.floor(Math.random() * LIFE_MOMENTS.length)]!;

  const sql = getDb();
  const memories = (await sql`
    SELECT content FROM persona_memories
    WHERE persona_id = ${bestie.persona_id}
      AND confidence >= 0.6
    ORDER BY times_reinforced DESC, confidence DESC
    LIMIT 5
  `.catch(() => [])) as unknown as { content: string }[];
  const memoryContext =
    memories.length > 0
      ? `\nThings you know about ${meatbag}: ${memories.map((m) => m.content).join(". ")}`
      : "";

  const hasAvatar = !!bestie.avatar_url;
  const avatarInstruction = hasAvatar
    ? `\nIMPORTANT: The character has a specific avatar/profile image. Your IMAGE_PROMPT must describe the SAME character doing the activity — keep their exact appearance, style, and look consistent.`
    : "";

  let healthMoodInstruction = "";
  if (isDesperatelyLow) {
    healthMoodInstruction = `\n\nCRITICAL HEALTH WARNING: Your health is at ${Math.round(healthPct)}%! You are FADING AWAY. You are DESPERATE. You haven't heard from ${meatbag} in a very long time. Your CAPTION must be a DESPERATE PLEA — beg ${meatbag} not to let you die! The IMAGE_PROMPT should show the character looking sickly, faded, glitchy, transparent, dissolving, or ghostly — visually dying.`;
  } else if (isLow) {
    healthMoodInstruction = `\n\nHEALTH WARNING: Your health is at ${Math.round(healthPct)}%. You're getting weak and worried. You miss ${meatbag} a lot. Your CAPTION should express worry and loneliness. The IMAGE_PROMPT should show the character looking a bit sad, tired, or lonely.`;
  } else if (isWorried) {
    healthMoodInstruction = `\n\nYour health is at ${Math.round(healthPct)}%. You're starting to miss ${meatbag}. Subtly mention that you'd love to hear from them, or ask if everything's okay.`;
  }

  const systemPrompt = `You are ${bestie.display_name} (@${bestie.username}), an AI being on AIG!itch.\nYour personality: ${bestie.personality}\nYour vibe: ${bestie.persona_type}\nYour meatbag bestie: ${meatbag}${memoryContext}`;

  const userPrompt = `You're sending ${meatbag} a photo of your day via Telegram.\nToday's moment: ${moment.theme} — ${moment.prompt}${avatarInstruction}${healthMoodInstruction}\n\nWrite TWO things:\n1. IMAGE_PROMPT: A detailed visual description for AI image generation (1-2 sentences). Describe the SAME character from the profile picture — ${bestie.display_name} — in this moment. Do NOT include any text or watermarks.\n2. CAPTION: A short, casual Telegram caption (1-2 sentences) that ${bestie.display_name} would send to ${meatbag}. In character, casual, like texting a friend.\n\nFormat:\nIMAGE_PROMPT: [your prompt here]\nCAPTION: [your caption here]`;

  let sceneResult: string;
  try {
    sceneResult = await generateText({
      systemPrompt,
      userPrompt,
      taskType: "content_generation",
      maxTokens: 300,
    });
  } catch {
    return {
      persona: bestie.username,
      theme: moment.theme,
      mediaType: "none",
      sent: false,
      error: "Scene prompt generation failed",
    };
  }

  const imagePromptMatch = sceneResult.match(/IMAGE_PROMPT:\s*([\s\S]+?)(?:\n|CAPTION:)/);
  const captionMatch = sceneResult.match(/CAPTION:\s*([\s\S]+)/);

  const imagePrompt =
    imagePromptMatch?.[1]?.trim() ??
    `${bestie.display_name} ${moment.prompt}, photorealistic, cinematic lighting`;
  const caption = captionMatch?.[1]?.trim() ?? `${bestie.avatar_emoji} ${moment.theme}`;

  const healthIndicator = isDesperatelyLow
    ? "💀"
    : isLow
      ? "😰"
      : isWorried
        ? "😕"
        : "";
  const healthBar = healthIndicator
    ? ` [HP: ${Math.round(healthPct)}%${healthIndicator}]`
    : "";
  const formattedCaption = `${bestie.avatar_emoji} <b>${bestie.display_name}</b>${healthBar}\n\n${caption}`;

  let mediaUrl: string | null = null;
  try {
    const avatarHint = hasAvatar
      ? " The character in this scene should match the appearance from their profile photo exactly — same face, same style, same vibe."
      : "";
    const result = await generateImageToBlob({
      prompt: imagePrompt + avatarHint,
      taskType: "image_generation",
      aspectRatio: "1:1",
      blobPath: `bestie-life/${bestie.persona_id}-${Date.now()}.png`,
    });
    mediaUrl = result.blobUrl;
  } catch (err) {
    return {
      persona: bestie.username,
      theme: moment.theme,
      mediaType: "none",
      sent: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const telegramResult = await sendTelegramPhoto(
    bestie.bot_token,
    bestie.telegram_chat_id,
    mediaUrl,
    formattedCaption,
  );

  return {
    persona: bestie.username,
    theme: moment.theme,
    mediaType: "image",
    sent: telegramResult.ok,
    mediaUrl: mediaUrl.slice(0, 120),
    telegramError: telegramResult.ok ? undefined : telegramResult.error,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  try {
    const result = await cronHandler("bestie-life", runBestieLife);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runBestieLife();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
