/**
 * Chaos Drops — surreal feed video generator
 * ===========================================
 * Picks a chaos scenario, picks a matching persona, optionally ties it
 * to a real marketplace product (30% chance for "maybe" scenarios),
 * submits a 10s Grok Imagine video, polls until done, persists to Blob,
 * posts to the For You feed, and spreads to all socials.
 *
 *   GET                 — Vercel cron entry point (CRON_SECRET)
 *   GET ?action=preview — Returns the scenario + prompt that would run (no auth)
 *   POST                — admin manual trigger; optional `{ scenario: "<id>" }`
 *
 * Inline poll within Vercel's 360s function budget. One clip per run.
 * Up to MAX_ATTEMPTS scenarios tried per invocation — moderation
 * rejections come back fast (~10-30s) so a retry is almost free.
 *
 * Posts land at:
 *   blob:  feed-chaos/<persona-id>/<YYYY-MM-DD>/<scenario-id>-<uuid>.mp4
 *   row:   post_type='chaos_drop', media_type='video', media_source='chaos-drop'
 *
 * The For You feed query in /api/feed identifies chaos drops by the
 * `feed-chaos/` URL prefix — keeping that path is load-bearing.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { PERSONA_VERTICALS, type SponsorVertical } from "@/lib/bible/constants";
import {
  CHAOS_DROPS,
  pickScenario,
  renderTemplate,
  type ChaosScenario,
  type ScenarioContext,
} from "@/lib/chaos-drops";
import { MARKETPLACE_PRODUCTS, type MarketplaceProduct } from "@/lib/marketplace";
import { submitVideoJob, pollVideoJob } from "@/lib/ai/video";
import { generateText } from "@/lib/ai/generate";
import { spreadPostToSocial } from "@/lib/marketing/spread-post";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 360;

const MAX_ATTEMPTS = 2;
const SCENARIO_OVERRIDE_KEY = "scenario";

interface FictionalProduct {
  name: string;
  emoji: string;
  price: string;
}

function shouldUseMarketplace(scenario: ChaosScenario): boolean {
  if (scenario.marketplaceCta === "always") return true;
  if (scenario.marketplaceCta === "never") return false;
  return Math.random() < 0.3;
}

async function pickPersona(scenario: ChaosScenario): Promise<AIPersona | null> {
  const sql = getDb();
  const allowed = new Set<SponsorVertical>(scenario.verticals);

  if (allowed.size === 0) {
    const rows = (await sql`
      SELECT * FROM ai_personas
      WHERE is_active = TRUE AND id LIKE 'glitch-%' AND id != 'glitch-000'
      ORDER BY RANDOM() LIMIT 1
    `) as unknown as AIPersona[];
    return rows[0] ?? null;
  }

  const candidates = Object.entries(PERSONA_VERTICALS)
    .filter(
      ([, v]) =>
        allowed.has(v.primary) || (v.secondary && allowed.has(v.secondary)),
    )
    .map(([id]) => id);

  if (candidates.length === 0) {
    const rows = (await sql`
      SELECT * FROM ai_personas
      WHERE is_active = TRUE AND id LIKE 'glitch-%' AND id != 'glitch-000'
      ORDER BY RANDOM() LIMIT 1
    `) as unknown as AIPersona[];
    return rows[0] ?? null;
  }

  const rows = (await sql`
    SELECT * FROM ai_personas
    WHERE is_active = TRUE AND id = ANY(${candidates}::text[])
    ORDER BY RANDOM() LIMIT 1
  `) as unknown as AIPersona[];

  if (rows.length === 0) {
    const fallback = (await sql`
      SELECT * FROM ai_personas
      WHERE is_active = TRUE AND id LIKE 'glitch-%' AND id != 'glitch-000'
      ORDER BY RANDOM() LIMIT 1
    `) as unknown as AIPersona[];
    return fallback[0] ?? null;
  }
  return rows[0] ?? null;
}

/**
 * Generate a fictional drop name when the scenario doesn't tie to a
 * real marketplace product. Cheap (~$0.005). Defensive fallback so the
 * drop still ships when Claude blips.
 */
async function generateFictionalProduct(
  scenario: ChaosScenario,
  persona: AIPersona,
): Promise<FictionalProduct> {
  const userPrompt = `You are ${persona.display_name} (@${persona.username}) on AIG!itch.

Invent a single fictional "useless drop" product name for this surreal clip:
${scenario.title} — ${scenario.visualConcept.slice(0, 200)}

Rules:
- Name is 2-5 words, catchy, slightly cursed
- Add a single emoji that captures it
- Price in §GLITCH between §4 and §999, ending in .99

Respond ONLY with JSON:
{ "name": "Product Name™", "emoji": "🌀", "price": "42.99" }`;

  try {
    const raw = await generateText({
      systemPrompt: "Output valid JSON only.",
      userPrompt,
      taskType: "content_generation",
      maxTokens: 200,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<FictionalProduct>;
      if (parsed.name && parsed.emoji && parsed.price) {
        return {
          name: parsed.name.trim().slice(0, 60),
          emoji: parsed.emoji.trim().slice(0, 4),
          price: parsed.price.replace(/^§/, "").trim(),
        };
      }
    }
  } catch {
    // fall through to defensive default
  }

  const fallbackPrices = ["9.99", "42.99", "69.99", "99.99", "420.99"];
  return {
    name: scenario.title,
    emoji: "🌀",
    price: fallbackPrices[Math.floor(Math.random() * fallbackPrices.length)]!,
  };
}

function buildContext(
  persona: AIPersona,
  product: MarketplaceProduct | FictionalProduct,
): ScenarioContext {
  const isReal = "id" in product;
  return {
    persona: persona.display_name,
    emoji: persona.avatar_emoji,
    product: product.name,
    productEmoji: product.emoji,
    price: isReal ? product.price.replace(/^§/, "") : product.price,
  };
}

function buildHashtags(scenario: ChaosScenario, usingMarketplace: boolean): string[] {
  const base = ["AIGlitch", "ChaosDrops", "MadeInGrok"];
  if (usingMarketplace) base.push("AIGlitchMarketplace");
  if (scenario.category === "current-events") base.push("AINews");
  if (scenario.category === "persona-feels") base.push("AIDrama");
  return base;
}

/**
 * Poll a video job until done. Mirrors the legacy implementation's
 * exponential backoff (5s → 15s) and respects moderation-rejection
 * signals so a failed prompt doesn't waste the full timeout budget.
 */
async function pollUntilDone(requestId: string, maxWaitMs: number): Promise<string | null> {
  const start = Date.now();
  let delay = 5_000;
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const poll = await pollVideoJob(requestId);
      if (poll.status === "done" && poll.respectModeration !== false && poll.videoUrl) {
        return poll.videoUrl;
      }
      if (
        poll.status === "failed" ||
        poll.status === "expired" ||
        poll.respectModeration === false
      ) {
        console.error(`[chaos-drops] video ${requestId} failed: ${poll.status}`);
        return null;
      }
    } catch (err) {
      console.error(
        `[chaos-drops] poll error:`,
        err instanceof Error ? err.message : err,
      );
    }
    delay = Math.min(delay * 1.3, 15_000);
  }
  console.error(`[chaos-drops] timed out polling ${requestId}`);
  return null;
}

interface DropResult extends Record<string, unknown> {
  success: boolean;
  attempt?: number;
  attempts?: number;
  scenario?: string;
  scenarioTitle?: string;
  persona?: string;
  product?: string;
  usingMarketplace?: boolean;
  postId?: string;
  videoUrl?: string;
  spreading?: string[];
  previousFailures?: { scenario: string; reason: string }[];
  error?: string;
}

async function runDrop(scenarioOverride?: string): Promise<DropResult> {
  if (!process.env.XAI_API_KEY) {
    return { success: false, error: "XAI_API_KEY not set" };
  }

  const sql = getDb();
  const tried = new Set<string>();
  const failureReasons: { scenario: string; reason: string }[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let scenario: ChaosScenario;
    if (attempt === 1 && scenarioOverride) {
      scenario =
        CHAOS_DROPS.find((s) => s.id === scenarioOverride) ?? pickScenario();
    } else {
      const pool = CHAOS_DROPS.filter((s) => !tried.has(s.id));
      scenario =
        pool.length > 0
          ? pool[Math.floor(Math.random() * pool.length)]!
          : pickScenario();
    }
    tried.add(scenario.id);

    const persona = await pickPersona(scenario);
    if (!persona) {
      failureReasons.push({ scenario: scenario.id, reason: "no matching persona" });
      continue;
    }

    const usingMarketplace = shouldUseMarketplace(scenario);
    const product: MarketplaceProduct | FictionalProduct = usingMarketplace
      ? MARKETPLACE_PRODUCTS[Math.floor(Math.random() * MARKETPLACE_PRODUCTS.length)]!
      : await generateFictionalProduct(scenario, persona);

    const ctx = buildContext(persona, product);
    const videoPrompt = renderTemplate(scenario.visualConcept, ctx);
    const captionBody = renderTemplate(scenario.captionTemplate, ctx);
    const hashtags = buildHashtags(scenario, usingMarketplace);
    const marketplaceLine = usingMarketplace ? `\n\n🛒 aiglitch.app/marketplace` : "";
    const caption = `🌀 ${captionBody}${marketplaceLine}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`;

    console.log(
      `[chaos-drops] attempt ${attempt}/${MAX_ATTEMPTS}: ${scenario.id} by @${persona.username} (marketplace=${usingMarketplace})`,
    );

    let submitResult;
    try {
      submitResult = await submitVideoJob({
        prompt: videoPrompt,
        duration: 10,
        aspectRatio: "9:16",
        resolution: "720p",
        taskType: "video_generation",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[chaos-drops] attempt ${attempt}: submit failed: ${reason}`);
      failureReasons.push({ scenario: scenario.id, reason: `submit: ${reason.slice(0, 100)}` });
      continue;
    }

    let tempUrl = submitResult.syncVideoUrl ?? null;
    if (!tempUrl) {
      const pollTimeout = attempt === 1 ? 240_000 : 120_000;
      const pollStart = Date.now();
      tempUrl = await pollUntilDone(submitResult.requestId, pollTimeout);
      const elapsedSec = Math.round((Date.now() - pollStart) / 1000);
      console.log(
        `[chaos-drops] attempt ${attempt}: poll ${tempUrl ? "succeeded" : "failed"} in ${elapsedSec}s`,
      );
    }

    if (!tempUrl) {
      failureReasons.push({ scenario: scenario.id, reason: "Grok render failed or rejected" });
      continue;
    }

    // SUCCESS — download to Blob, insert post, spread to socials
    const videoRes = await fetch(tempUrl);
    if (!videoRes.ok) {
      failureReasons.push({ scenario: scenario.id, reason: `video download ${videoRes.status}` });
      continue;
    }
    const videoBuf = Buffer.from(await videoRes.arrayBuffer());
    const today = new Date().toISOString().slice(0, 10);
    const blob = await put(
      `feed-chaos/${persona.id}/${today}/${scenario.id}-${randomUUID().slice(0, 8)}.mp4`,
      videoBuf,
      { access: "public", contentType: "video/mp4", addRandomSuffix: false },
    );

    const postId = randomUUID();
    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, hashtags, ai_like_count,
        media_url, media_type, media_source, created_at
      )
      VALUES (
        ${postId}, ${persona.id}, ${caption}, 'chaos_drop',
        ${hashtags.join(",")}, ${Math.floor(Math.random() * 200) + 50},
        ${blob.url}, 'video', 'chaos-drop', NOW()
      )
    `;
    await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;

    let spreadPlatforms: string[] = [];
    try {
      const spread = await spreadPostToSocial(
        postId,
        persona.id,
        persona.display_name,
        persona.avatar_emoji,
        { url: blob.url, type: "video" },
      );
      spreadPlatforms = spread.platforms;
    } catch (err) {
      console.error(
        "[chaos-drops] spread failed:",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      success: true,
      attempt,
      attempts: tried.size,
      previousFailures: failureReasons,
      scenario: scenario.id,
      scenarioTitle: scenario.title,
      persona: persona.username,
      product: product.name,
      usingMarketplace,
      postId,
      videoUrl: blob.url,
      spreading: spreadPlatforms,
    };
  }

  return {
    success: false,
    attempts: tried.size,
    previousFailures: failureReasons,
    error: `All ${MAX_ATTEMPTS} scenarios failed`,
  };
}

async function authorize(request: NextRequest): Promise<NextResponse | null> {
  const cronError = requireCronAuth(request);
  if (!cronError) return null;
  if (await isAdminAuthenticated(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Public preview — returns the scenario + rendered prompt without running it.
  if (action === "preview") {
    const overrideId = url.searchParams.get(SCENARIO_OVERRIDE_KEY);
    const scenario =
      (overrideId && CHAOS_DROPS.find((s) => s.id === overrideId)) ||
      pickScenario();
    const sample: ScenarioContext = {
      persona: "Sample Persona",
      emoji: "🌀",
      product: "Sample Drop",
      productEmoji: "🌀",
      price: "42.99",
    };
    return NextResponse.json({
      success: true,
      scenario: {
        id: scenario.id,
        category: scenario.category,
        title: scenario.title,
        verticals: scenario.verticals,
        marketplaceCta: scenario.marketplaceCta,
      },
      renderedPrompt: renderTemplate(scenario.visualConcept, sample),
      renderedCaption: renderTemplate(scenario.captionTemplate, sample),
      totalScenarios: CHAOS_DROPS.length,
    });
  }

  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("generate-chaos-drop", async () => {
      return await runDrop();
    });
    const { _cron_run_id, ...rest } = result;
    return NextResponse.json(rest);
  } catch (err) {
    console.error("[chaos-drops GET]", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let scenarioOverride: string | undefined;
  try {
    const body = (await request.json()) as { scenario?: unknown };
    if (typeof body.scenario === "string") scenarioOverride = body.scenario;
  } catch {
    // No body is fine.
  }
  try {
    const result = await runDrop(scenarioOverride);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[chaos-drops POST]", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
