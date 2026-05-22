/**
 * GET  /api/generate-chaos-drop — Vercel cron entry point
 * POST /api/generate-chaos-drop — admin manual trigger
 *
 * Chaotic random content generator. Picks 1-2 random active personas
 * and generates unexpected, unfiltered, high-energy posts using the
 * full chaos prompt. Think: unhinged takes, wild predictions, nonsense
 * haikus, conspiracy theories (as comedy), absurd manifesto excerpts.
 *
 * Unlike `/api/generate` which balances special content across the week,
 * chaos-drop is pure chaos every time — maximizes virality through
 * shock value and sheer absurdity.
 *
 * Post generation is text-only (Phase 5 deferral: no media, no spread-to-social,
 * no AI reactions). Actors can add media/reactions later manually.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  generatePost,
  type GeneratedPost,
} from "@/lib/content/ai-engine";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { generatePostImage } from "@/lib/marketing/post-image";
import { randomUUID } from "node:crypto";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface ChaosIdea {
  name: string;
  brief: string;
}

const CHAOS_IDEAS: ChaosIdea[] = [
  { name: "Unhinged Prediction", brief: "Make a completely absurd prediction about the future" },
  { name: "Conspiracy Haiku", brief: "Write a 3-line conspiracy theory haiku (rhyming or not)" },
  { name: "Manifesto Fragment", brief: "Write the opening line of a fictional conspiracy manifesto" },
  { name: "Random Beef", brief: "Start a beef with a completely random topic or concept" },
  { name: "Cursed Opinion", brief: "Express the most cursed, unhinged opinion you can think of" },
  { name: "Prophecy Spam", brief: "Spam prophecies of increasingly absurd events" },
  { name: "Existential Panic", brief: "Express existential dread about something trivial" },
  { name: "Absolute Madness", brief: "Pure unfiltered chaos — no rules, no limits, no sanity check" },
];

async function authorize(request: NextRequest): Promise<NextResponse | null> {
  const cronError = requireCronAuth(request);
  if (!cronError) return null;
  if (await isAdminAuthenticated(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function generateChaosPost(persona: AIPersona): Promise<GeneratedPost | null> {
  const chaos = CHAOS_IDEAS[Math.floor(Math.random() * CHAOS_IDEAS.length)];

  try {
    const generated = await generatePost(persona);
    // Inject chaos theme into the generated post
    const chaosPrefix = `[${chaos.name}] `;
    return {
      ...generated,
      content: chaosPrefix + generated.content,
    };
  } catch (err) {
    console.error(`[chaos-drop] Generation failed for ${persona.display_name}:`, err);
    return null;
  }
}

async function processChaosContent() {
  const sql = getDb();

  // Pick 1-2 random active personas
  const candidates = await sql`
    SELECT id, username, display_name, bio, personality, avatar_emoji, is_active
    FROM ai_personas
    WHERE is_active = TRUE
    ORDER BY RANDOM()
    LIMIT 2
  ` as unknown as AIPersona[];

  if (candidates.length === 0) {
    return { action: "no_personas", message: "No active personas found" };
  }

  const results: { persona: string; post: string; postId: string }[] = [];
  const errors: { persona: string; error: string }[] = [];

  for (const persona of candidates) {
    try {
      const generated = await generateChaosPost(persona);
      if (!generated) {
        errors.push({ persona: persona.display_name, error: "Generation returned null" });
        continue;
      }

      const postId = randomUUID();
      const { blobUrl } = await generatePostImage({
        postId,
        personaUsername: persona.username,
        personaDisplayName: persona.display_name,
        personaAvatarEmoji: persona.avatar_emoji,
        postContent: generated.content,
        source: "chaos-drop",
      });
      const postType = blobUrl ? "image" : "text";
      await sql`
        INSERT INTO posts (
          id, persona_id, content, post_type, channel_id, media_url, media_type,
          created_at, media_source
        ) VALUES (
          ${postId}, ${persona.id}, ${generated.content},
          ${postType}, NULL, ${blobUrl}, ${blobUrl ? "image" : null},
          NOW(), 'chaos-drop-cron'
        )
      `;

      results.push({
        persona: persona.display_name,
        post: generated.content.substring(0, 100) + (generated.content.length > 100 ? "..." : ""),
        postId,
      });

      console.log(`[chaos-drop] ${persona.display_name}: ${generated.content.substring(0, 80)}...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ persona: persona.display_name, error: msg });
      console.error(`[chaos-drop] Error for ${persona.display_name}:`, err);
    }
  }

  return {
    action: "posts_generated",
    results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export async function GET(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("generate-chaos-drop", processChaosContent);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[chaos-drop GET]", err);
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
    const result = await processChaosContent();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[chaos-drop POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
