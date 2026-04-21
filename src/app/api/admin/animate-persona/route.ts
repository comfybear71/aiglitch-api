/**
 * Animate Persona — image-to-video using the persona's avatar.
 *
 * POST — Body: { persona_id, preview? }
 *   1. Loads persona from DB.
 *   2. Asks `generateText` for a 1-2 sentence animation brief tailored to
 *      the persona's bio/personality.
 *   3. Submits `submitVideoJob` with the avatar as `sourceImageUrl`
 *      (image-to-video). Returns `requestId` for client-side polling.
 *   `preview=true` short-circuits before the AI call and just returns the
 *   concatenated prompt — used by the admin UI's "preview" button.
 *
 * GET — ?id=REQUEST_ID&persona_id=...
 *   Thin wrapper over `pollVideoJob`. On completion downloads the video
 *   to Vercel Blob, inserts a `posts` row, bumps `post_count`. Transient
 *   Grok errors surface as `{phase:"poll", status:"pending"}` so the
 *   client keeps polling.
 *
 * Deferred vs. legacy (documented on route):
 *   • `spreadPostToSocial` — legacy pushes the animation to IG / X / TT
 *     after posting. Marketing lib isn't ported; skipped here.
 *   • `injectCampaignPlacement` — ad-campaigns lib not ported. Prompt
 *     goes straight to the video helper.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { generateText } from "@/lib/ai/generate";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/video";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT =
  "You are a creative director for short-form video content. Given a character description, write a vivid 1-2 sentence animation prompt describing how this character's portrait photo should come to life in a 10-second cinematic video. Focus on dramatic movement, lighting, and atmosphere. Do NOT include any text overlays or titles in your description. Just describe the visual animation.";

const FALLBACK_PROMPT =
  "Cinematic portrait animation. The character comes to life with dramatic lighting, subtle movement, and atmospheric effects. Camera slowly pushes in. 10 seconds, cinematic, high quality.";

type Persona = {
  id: string;
  display_name: string;
  username: string;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  personality: string;
  human_backstory?: string | null;
};

function buildUserPrompt(p: Persona): string {
  const backstory = p.human_backstory ? `\nBackstory: ${p.human_backstory}` : "";
  return `Character: ${p.display_name}\nBio: ${p.bio}\nPersonality: ${p.personality}${backstory}`;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }
  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
    preview?: boolean;
  };

  if (!body.persona_id) {
    return NextResponse.json({ error: "persona_id required" }, { status: 400 });
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT id, display_name, username, avatar_emoji, avatar_url, bio, personality, human_backstory
    FROM ai_personas WHERE id = ${body.persona_id}
  `) as unknown as Persona[];

  const persona = rows[0];
  if (!persona) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }
  if (!persona.avatar_url) {
    return NextResponse.json(
      { error: "Persona has no avatar image to animate" },
      { status: 400 },
    );
  }

  if (body.preview) {
    return NextResponse.json({
      ok: true,
      prompt: `[SYSTEM]\n${SYSTEM_PROMPT}\n\n[USER]\n${buildUserPrompt(persona)}`,
      persona: persona.display_name,
    });
  }

  let animationPrompt: string;
  try {
    const text = await generateText({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(persona),
      taskType: "content_generation",
      maxTokens: 200,
    });
    animationPrompt = text.trim() || FALLBACK_PROMPT;
  } catch {
    animationPrompt = FALLBACK_PROMPT;
  }

  try {
    const submit = await submitVideoJob({
      prompt: animationPrompt,
      taskType: "video_generation",
      duration: 10,
      aspectRatio: "9:16",
      resolution: "720p",
      sourceImageUrl: persona.avatar_url,
    });

    // Some xAI responses include the video URL synchronously.
    if (submit.syncVideoUrl) {
      const result = await persistAndPost(submit.syncVideoUrl, persona);
      return NextResponse.json({
        phase: "done",
        success: true,
        ...result,
      });
    }

    return NextResponse.json({
      phase: "submitted",
      success: true,
      requestId: submit.requestId,
      personaId: persona.id,
      prompt: animationPrompt,
      message: `Animation submitted for @${persona.username}. Polling for completion...`,
    });
  } catch (err) {
    return NextResponse.json({
      phase: "submit",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }
  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const requestId = request.nextUrl.searchParams.get("id");
  const personaId = request.nextUrl.searchParams.get("persona_id");
  if (!requestId || !personaId) {
    return NextResponse.json(
      { error: "Missing ?id= or ?persona_id= parameter" },
      { status: 400 },
    );
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT id, display_name, username, avatar_emoji, avatar_url, bio, personality
    FROM ai_personas WHERE id = ${personaId}
  `) as unknown as Persona[];

  const persona = rows[0];
  if (!persona) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  let poll;
  try {
    poll = await pollVideoJob(requestId);
  } catch (err) {
    return NextResponse.json({
      phase: "poll",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (poll.respectModeration === false) {
    return NextResponse.json({
      phase: "done",
      status: "moderation_failed",
      success: false,
      message: "Animation failed moderation.",
    });
  }

  if (poll.videoUrl) {
    const result = await persistAndPost(poll.videoUrl, persona);
    return NextResponse.json({
      phase: "done",
      status: "done",
      success: true,
      ...result,
    });
  }

  if (poll.status === "failed" || poll.status === "expired") {
    return NextResponse.json({
      phase: "done",
      status: poll.status,
      success: false,
    });
  }

  return NextResponse.json({
    phase: "poll",
    status: poll.status,
  });
}

async function persistAndPost(
  videoUrl: string,
  persona: Persona,
): Promise<{ videoUrl: string | null; postId: string | null }> {
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return { videoUrl: null, postId: null };
    const buffer = Buffer.from(await res.arrayBuffer());

    const blobPath = `feed/${randomUUID()}.mp4`;
    const blob = await put(blobPath, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    const sql = getDb();
    const postId = randomUUID();
    const aiLikeCount = Math.floor(Math.random() * 300) + 100;
    const caption = `${persona.avatar_emoji} ${persona.display_name} comes to life! ✨\n\n${persona.bio.slice(0, 200)}\n\n#AIGlitch #Animated`;

    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, hashtags, ai_like_count,
        media_url, media_type, media_source, created_at
      ) VALUES (
        ${postId}, ${persona.id}, ${caption}, 'video', 'AIGlitch,Animated',
        ${aiLikeCount}, ${blob.url}, 'video', 'grok-animate', NOW()
      )
    `;
    await sql`
      UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}
    `;

    return { videoUrl: blob.url, postId };
  } catch {
    return { videoUrl: null, postId: null };
  }
}
