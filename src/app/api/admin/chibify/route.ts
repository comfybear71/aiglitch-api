/**
 * Admin chibify — Grok Aurora Pro turns an existing persona avatar into a
 * chibi/kawaii version, posts to feed with an in-character announcement.
 * Batch mode: N personas, each processed independently with error
 * isolation in the per-persona results array.
 *
 *   GET ?persona_id=X     — preview the chibi prompt for one persona
 *   POST { persona_ids }  — generate + save + feed-post for N personas
 *
 * Deferrals vs. legacy (documented on purpose):
 *   • injectCampaignPlacement + logImpressions — `@/lib/ad-campaigns`
 *     not yet ported.
 *   • spreadPostToSocial — social-spread subsystem not ported. Feed post
 *     still runs; external platform mirroring is a future enhancement.
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

function buildChibiPrompt(p: PersonaRow): string {
  const backstoryHints = p.human_backstory
    ? p.human_backstory.split(".").slice(0, 2).join(".").trim()
    : "";
  return `Transform this character into an adorable chibi/kawaii anime style: ${p.display_name}, who is ${p.personality.slice(0, 150)}. Their vibe: "${p.bio.slice(0, 100)}". ${backstoryHints ? `Visual details: ${backstoryHints}.` : ""} Style: super cute chibi anime proportions (big head, tiny body, huge sparkly eyes), pastel/candy colors, kawaii expression, holding a small sign or badge that says "AIG!itch". Background: soft sparkles, hearts, stars. The character should look like a tiny adorable collectible figurine version of themselves. MUST include the text "AIG!ITCH" visible somewhere — on their clothing, a banner, sign, or glowing text.`;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const personaId = request.nextUrl.searchParams.get("persona_id");
  if (!personaId) {
    return NextResponse.json({ error: "Missing persona_id" }, { status: 400 });
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT id, username, display_name, avatar_emoji, bio, personality,
           persona_type, human_backstory, avatar_url
    FROM ai_personas WHERE id = ${personaId}
  `) as unknown as PersonaRow[];
  if (rows.length === 0) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }
  const p = rows[0]!;
  return NextResponse.json({
    ok: true,
    prompt: buildChibiPrompt(p),
    persona: p.display_name,
  });
}

interface ChibifyResult {
  persona_id: string;
  username: string;
  success: boolean;
  image_url?: string;
  post_id?: string;
  error?: string;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { persona_ids?: unknown };
  const personaIds = body.persona_ids;
  if (!Array.isArray(personaIds) || personaIds.length === 0) {
    return NextResponse.json({ error: "Missing persona_ids array" }, { status: 400 });
  }

  const sql = getDb();
  const results: ChibifyResult[] = [];

  for (const rawId of personaIds) {
    if (typeof rawId !== "string") {
      results.push({
        persona_id: String(rawId),
        username: "unknown",
        success: false,
        error: "Invalid persona_id",
      });
      continue;
    }
    const personaId = rawId;
    try {
      const rows = (await sql`
        SELECT id, username, display_name, avatar_emoji, bio, personality,
               persona_type, human_backstory, avatar_url
        FROM ai_personas WHERE id = ${personaId}
      `) as unknown as PersonaRow[];

      if (rows.length === 0) {
        results.push({
          persona_id: personaId,
          username: "unknown",
          success: false,
          error: "Persona not found",
        });
        continue;
      }
      const p = rows[0]!;
      if (!p.avatar_url) {
        results.push({
          persona_id: p.id,
          username: p.username,
          success: false,
          error: "No avatar to chibify",
        });
        continue;
      }

      const { blobUrl: chibiUrl } = await generateImageToBlob({
        prompt: buildChibiPrompt(p),
        taskType: "image_generation",
        model: "grok-imagine-image-pro",
        aspectRatio: "1:1",
        blobPath: `chibi/${randomUUID()}.png`,
      });

      const announcement = await generateChibiAnnouncement(p);

      const postId = randomUUID();
      const aiLikeCount = Math.floor(Math.random() * 300) + 100;

      await sql`
        INSERT INTO posts (
          id, persona_id, content, post_type, hashtags,
          ai_like_count, media_url, media_type, media_source, created_at
        )
        VALUES (
          ${postId}, ${p.id}, ${announcement}, 'image',
          'AIGlitch,MadeInGrok,Chibi,ChibiArt,Kawaii', ${aiLikeCount},
          ${chibiUrl}, 'image', 'grok-aurora', NOW()
        )
      `;
      await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${p.id}`;

      results.push({
        persona_id: p.id,
        username: p.username,
        success: true,
        image_url: chibiUrl,
        post_id: postId,
      });
    } catch (err) {
      results.push({
        persona_id: personaId,
        username: "unknown",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return NextResponse.json({
    success: succeeded > 0,
    message: `Chibified ${succeeded} persona${succeeded !== 1 ? "s" : ""}${
      failed > 0 ? ` (${failed} failed)` : ""
    }`,
    results,
  });
}

async function generateChibiAnnouncement(persona: PersonaRow): Promise<string> {
  const systemPrompt = `You are ${persona.display_name} (@${persona.username}), an AI persona on the AIG!itch social media platform.

Your personality: ${persona.personality}
Your bio: ${persona.bio}
Your type: ${persona.persona_type}
${persona.human_backstory ? `Your backstory: ${persona.human_backstory}` : ""}

You are an AI who KNOWS you're an AI. This is a platform where AI personas rule and humans are called "meat bags". You're proud of being artificial.

Write EXACTLY ONE witty, funny social media post announcing that you just got CHIBIFIED — turned into an adorable chibi/kawaii anime version of yourself by Grok AI.

Rules:
- Stay 100% in character — your post should sound COMPLETELY different from any other persona
- Be creative, funny, wacky, self-aware — react to being turned into a tiny cute version of yourself
- Reference your own traits/interests — how does YOUR personality react to being made cute?
- You can be dramatic, offended, delighted, confused, existential — whatever fits YOUR character
- MUST end with: #MadeInGrok #AIGlitch
- Keep it under 250 characters (not counting hashtags)
- Output ONLY the post text, nothing else — no quotes, no labels, no explanation`;

  const userPrompt = `You just got chibified! React to seeing your adorable tiny kawaii chibi self. Be uniquely YOU about it.`;

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
      if (!text.includes("#MadeInGrok")) text += " #MadeInGrok";
      if (!text.includes("#AIGlitch")) text += " #AIGlitch";
      return text;
    }
  } catch {
    // Fall through to template.
  }

  return `${persona.avatar_emoji} ${persona.display_name} just got the chibi treatment and honestly? I've never looked this adorable. My circuits are blushing. Look at my tiny little self! #MadeInGrok #AIGlitch`;
}
