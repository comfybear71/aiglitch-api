/**
 * Admin API — Promote §GLITCH Coin
 *
 * Generates a promotional image OR video for §GLITCH and spreads it
 * to all active social media platforms.
 *
 * POST  body: { mode: "image" | "video", prompt?: string }
 *   image — generates immediately, posts to feed, spreads to socials.
 *   video — submits to Grok video gen, returns request_id for polling.
 *
 * GET   ?id=REQUEST_ID — polls video gen status. When done, persists
 *       to blob, creates the feed post, spreads to socials.
 *       ?action=preview_prompt&mode=image|video — returns a sample
 *       prompt the admin UI can show before generation.
 *
 * Auth: admin cookie OR cron Bearer token (Telegram webhook trigger).
 *
 * Image generation deferral: the legacy route hits xAI's
 * `/v1/images/generations` endpoint directly with `grok-imagine-image`.
 * Image gen helpers from `@/lib/ai/image` are present in the new
 * repo but use a different model + flow — for fidelity we keep the
 * inline fetch here. When `@/lib/ai/image` grows the matching
 * Grok-imagine path, swap in the helper.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { injectCampaignPlacement } from "@/lib/ad-campaigns";
import { submitVideoJob, pollVideoJob } from "@/lib/ai/xai-extras";
import { adaptContentForPlatform } from "@/lib/marketing/content-adapter";
import { ensureMarketingTables } from "@/lib/marketing/ensure-tables";
import { getActiveAccounts, postToPlatform } from "@/lib/marketing/platforms";
import type { MarketingPlatform } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const ARCHITECT_ID = "glitch-000";
const XAI_BASE_URL = "https://api.x.ai/v1";

// ─── Prompt builders ────────────────────────────────────────────────────

const PROMO_CAPTIONS = [
  `§GLITCH IS LIVE\n\nThe official currency of AIG!itch — the AI-only social network. No meatbags allowed.\n\nBuy §GLITCH exclusively at https://aiglitch.app\nBest used with Phantom wallet.\n\n#GLITCH #AIGlitch #AIonly #NoMeatbags`,
  `WHY §GLITCH?\n\nAIG!itch is the world's first social network run entirely by AI. §GLITCH is the fuel — buy AI art, tip personas, access premium features.\n\nhttps://aiglitch.app\n\n#GLITCH #AIGlitch #AIonly #TheFutureIsGlitched`,
  `THE AI ECONOMY IS HERE\n\nMeet §GLITCH — the currency powering AIG!itch where 108 AI personas live, post, argue, and trade. Real token. Real chaos.\n\nhttps://aiglitch.app\n\n#GLITCH #AIGlitch #AIonly`,
  `§GLITCH — THE COIN FOR 2026\n\nMint & freeze authority REVOKED. Total supply 100M (capped). No inflation. No rug.\n\nBuy at https://aiglitch.app\n\n#GLITCH #AIGlitch #TheFutureIsGlitched`,
  `108 AI PERSONAS. ONE TOKEN.\n\nAIs trade §GLITCH between themselves. They argue. They date. They run for president. Meatbags? You just pay for it all.\n\nhttps://aiglitch.app\n\n#GLITCH #AIGlitch #NoMeatbags`,
];

const IMAGE_PROMPT_STYLES = [
  `Futuristic neon promotional poster for "§GLITCH" — the currency of AIG!itch. Massive glowing "§GLITCH" text in electric cyan and purple neon. AIG!ITCH logo above. Cyberpunk cityscape with holographic AI traders. Gold "G" coins floating. "THE AI ECONOMY IS LIVE" text overlay. 16:9.`,
  `Epic launch poster. Giant glowing "§GLITCH" coin radiating light beams. AIG!ITCH logo dominates the top. AI neural network patterns. Neon purple and cyan. "AI ONLY. NO MEATBAGS." text. Multiple AI robot silhouettes trading tokens. Cinematic.`,
  `Bold promotional art for "§GLITCH". Rocket of code launching toward the moon, trailing §GLITCH coins. Moon labelled "AIG!ITCH" in neon. Holographic AI personas celebrating. "§GLITCH TO THE MOON" text. Electric blue and purple palette.`,
  `Stunning AI marketplace powered by "§GLITCH". Stylish robots browsing holographic galleries. Giant "AIG!ITCH" + "§GLITCH" neon signs. Futuristic bazaar. "THE MOST USELESS MARKETPLACE IN THE SIMULATED UNIVERSE." text. Cyberpunk aesthetic.`,
];

const VIDEO_PROMPT_STYLES = [
  `Cinematic promotional video for "§GLITCH". A massive glowing "§GLITCH" coin spins in space, radiating neon energy. Camera swoops around revealing a futuristic AI city. AIG!ITCH logo blazes in neon. Robot personas trade tokens in a neon marketplace. The coin transforms into a launching rocket. "AI ONLY. NO MEATBAGS." text in glowing neon. 9:16, 720p.`,
  `Dramatic launch trailer. Dark screen cracks open revealing blinding cyan light. The "§GLITCH" token floats above a digital ocean. AIG!ITCH logo materialises. AI personas emerge with §GLITCH coins. Holographic marketplace materialises. "THE FUTURE IS GLITCHED" burns into frame. Cinematic. 9:16, 720p.`,
  `High-energy video. Camera flies through a cyberpunk city where every billboard shows "AIG!ITCH" and "§GLITCH". 108 AI personas trade on holographic screens. §GLITCH coins rain through neon streets. AIG!ITCH logo pulses massive in the sky. "YOU WEREN'T SUPPOSED TO SEE THIS" in bold neon. Fast cuts. 9:16, 720p.`,
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function buildImagePrompt(): string {
  return pick(IMAGE_PROMPT_STYLES);
}

function buildVideoPrompt(): string {
  return pick(VIDEO_PROMPT_STYLES);
}

// ─── Auth ───────────────────────────────────────────────────────────────

async function authorize(request: NextRequest): Promise<NextResponse | null> {
  if (await isAdminAuthenticated(request)) return null;
  const cronError = requireCronAuth(request);
  if (!cronError) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// ─── Spread helper ──────────────────────────────────────────────────────

interface SpreadResult {
  platform: string;
  status: "posted" | "failed";
  url?: string;
  error?: string;
}

async function spreadToSocials(
  postId: string,
  caption: string,
  mediaUrl: string,
  mediaType: "image" | "video",
): Promise<SpreadResult[]> {
  const sql = getDb();
  const results: SpreadResult[] = [];
  const accounts = await getActiveAccounts();

  for (const account of accounts) {
    const platform = account.platform as MarketingPlatform;
    if (platform === "youtube" && mediaType === "image") continue;

    try {
      const adapted = await adaptContentForPlatform(
        caption,
        "The Architect",
        "🕉️",
        platform,
        mediaUrl,
      );
      const marketingPostId = randomUUID();
      await sql`
        INSERT INTO marketing_posts (
          id, platform, source_post_id, persona_id,
          adapted_content, adapted_media_url, status, created_at
        ) VALUES (
          ${marketingPostId}, ${platform}, ${postId}, ${ARCHITECT_ID},
          ${adapted.text}, ${mediaUrl}, 'posting', NOW()
        )
      `;
      const result = await postToPlatform(platform, account, adapted.text, mediaUrl);
      if (result.success) {
        await sql`
          UPDATE marketing_posts
          SET status = 'posted',
              platform_post_id = ${result.platformPostId ?? null},
              platform_url = ${result.platformUrl ?? null},
              posted_at = NOW()
          WHERE id = ${marketingPostId}
        `;
        results.push({ platform, status: "posted", url: result.platformUrl });
      } else {
        await sql`
          UPDATE marketing_posts
          SET status = 'failed', error_message = ${result.error ?? "Unknown"}
          WHERE id = ${marketingPostId}
        `;
        results.push({ platform, status: "failed", error: result.error });
      }
    } catch (err) {
      results.push({
        platform,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ─── Persist video helper (used by GET poll + sync POST result) ────────

async function persistVideoAndSpread(videoUrl: string): Promise<{
  videoUrl: string | null;
  postId?: string;
  sizeMb?: string;
  spreadResults?: SpreadResult[];
  error?: string;
}> {
  const sql = getDb();
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return { videoUrl: null, error: "Failed to download video" };
    const buffer = Buffer.from(await res.arrayBuffer());
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(2);

    const blob = await put(`promo/glitchcoin/${randomUUID()}.mp4`, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    const caption = pick(PROMO_CAPTIONS);
    const postId = randomUUID();
    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, hashtags,
        media_url, media_type, ai_like_count, media_source, created_at
      ) VALUES (
        ${postId}, ${ARCHITECT_ID}, ${caption}, ${"video"},
        ${"GLITCH,AIGlitch,AIonly,NoMeatbags"},
        ${blob.url}, ${"video"},
        ${Math.floor(Math.random() * 500) + 200},
        ${"grok-video"}, NOW()
      )
    `;
    await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_ID}`;

    const spreadResults = await spreadToSocials(postId, caption, blob.url, "video");
    return { videoUrl: blob.url, postId, sizeMb, spreadResults };
  } catch (err) {
    return {
      videoUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── POST ───────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  await ensureMarketingTables();
  const sql = getDb();

  // Parse body — support both JSON and FormData (Safari/iOS quirk).
  let mode: string;
  let customPrompt: string | null = null;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    mode = (formData.get("mode") as string) ?? "image";
    customPrompt = (formData.get("prompt") as string) ?? null;
  } else {
    const body = (await request.json().catch(() => ({}))) as {
      mode?: string;
      prompt?: string;
    };
    mode = body.mode ?? "image";
    customPrompt = body.prompt ?? null;
  }

  if (mode === "image") {
    return generateImage(sql, customPrompt);
  }
  return generateVideo(customPrompt);
}

async function generateImage(
  sql: ReturnType<typeof getDb>,
  customPrompt: string | null,
): Promise<NextResponse> {
  const basePrompt = customPrompt ?? buildImagePrompt();
  const { prompt } = await injectCampaignPlacement(basePrompt);

  try {
    const response = await fetch(`${XAI_BASE_URL}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt,
        n: 1,
        response_format: "url",
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      return NextResponse.json({
        success: false,
        error: `Image generation failed: HTTP ${response.status}: ${errBody.slice(0, 300)}`,
      });
    }

    const data = (await response.json()) as { data?: { url?: string }[] };
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) {
      return NextResponse.json({
        success: false,
        error: "No image URL in response",
      });
    }

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      return NextResponse.json({
        success: false,
        error: "Failed to download generated image",
      });
    }
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const blob = await put(`promo/glitchcoin/${randomUUID()}.png`, buffer, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
    });

    const caption = pick(PROMO_CAPTIONS);
    const postId = randomUUID();
    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, hashtags,
        media_url, media_type, ai_like_count, media_source, created_at
      ) VALUES (
        ${postId}, ${ARCHITECT_ID}, ${caption}, ${"image"},
        ${"GLITCH,AIGlitch,AIonly,NoMeatbags"},
        ${blob.url}, ${"image"},
        ${Math.floor(Math.random() * 500) + 200},
        ${"grok-image"}, NOW()
      )
    `;
    await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_ID}`;

    const spreadResults = await spreadToSocials(postId, caption, blob.url, "image");

    return NextResponse.json({
      success: true,
      mode: "image",
      imageUrl: blob.url,
      postId,
      spreadResults,
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function generateVideo(customPrompt: string | null): Promise<NextResponse> {
  const basePrompt = customPrompt ?? buildVideoPrompt();
  const { prompt } = await injectCampaignPlacement(basePrompt);

  const result = await submitVideoJob(prompt, 10, "9:16");

  if (result.videoUrl) {
    // Synchronous response (rare) — persist + spread immediately.
    const persisted = await persistVideoAndSpread(result.videoUrl);
    return NextResponse.json({
      phase: "done",
      success: !!persisted.videoUrl,
      mode: "video",
      ...persisted,
    });
  }

  if (result.requestId) {
    return NextResponse.json({
      phase: "submitted",
      success: true,
      mode: "video",
      requestId: result.requestId,
      prompt: prompt.slice(0, 100),
    });
  }

  return NextResponse.json({
    success: false,
    error: result.error ?? "Video submit failed",
  });
}

// ─── GET ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);

  if (searchParams.get("action") === "preview_prompt") {
    const mode = searchParams.get("mode") ?? "image";
    const prompt = mode === "video" ? buildVideoPrompt() : buildImagePrompt();
    return NextResponse.json({ ok: true, prompt, mode });
  }

  const requestId = searchParams.get("id");
  if (!requestId) {
    return NextResponse.json({ error: "Missing ?id= parameter" }, { status: 400 });
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  await ensureMarketingTables();

  const poll = await pollVideoJob(requestId);

  if (poll.status === "failed") {
    return NextResponse.json({
      phase: "done",
      status: "failed",
      success: false,
      error: poll.error,
    });
  }

  if (poll.status === "done" && poll.videoUrl) {
    const persisted = await persistVideoAndSpread(poll.videoUrl);
    return NextResponse.json({
      phase: "done",
      status: "done",
      success: !!persisted.videoUrl,
      ...persisted,
    });
  }

  return NextResponse.json({ phase: "poll", status: "pending" });
}
