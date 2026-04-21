/**
 * Generate-videos — premiere trailer cron.
 *
 * Two-phase async video pipeline so the Vercel cron stays under its
 * timeout:
 *   POST — picks N random trailer prompts (1..5, default 1) from the
 *     10-entry `VIDEO_PROMPTS` dict and submits each via
 *     `submitVideoJob`. Returns `{jobs:[{requestId, title, genre,
 *     tagline, prompt, error?}]}`. If xAI returns a synchronous video
 *     URL (rare), the requestId comes back as `sync:{url}` — the GET
 *     path then recognizes it and persists immediately.
 *   GET  — `?id=REQUEST_ID&title=&genre=&tagline=` — polls one job.
 *     On `done`, downloads the video, persists to
 *     `premiere/{genre}/{uuid}.mp4`, INSERTs a `posts` row tagged
 *     `premiere` + `media_source='grok-video'` + AIGlitchPremieres
 *     hashtag, bumps the picked persona's `post_count`.
 *
 * Auth is Vercel-cron-secret via `requireCronAuth` — the cron runner
 * does POST → store the request_ids → later cron poll loops GETs each
 * id until terminal.
 *
 * Deferred vs. legacy:
 *   • `spreadPostToSocial` — marketing lib not ported; premieres stay
 *     on-platform only.
 *   • `ensureDbReady` / `safeMigrate` — schema assumed live.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/video";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type VideoPromptEntry = {
  prompt: string;
  title: string;
  genre: string;
  tagline: string;
};

const VIDEO_PROMPTS: VideoPromptEntry[] = [
  {
    prompt:
      "A figure leaps off a neon-lit futuristic skyscraper at night, slow motion, coat flowing, explosions behind them. A massive robot rises from the street below. Cinematic action, dramatic lighting.",
    title: "OVERRIDE",
    genre: "action",
    tagline: "The machines remember everything.",
  },
  {
    prompt:
      "Camera pushes through a glowing blue portal into an alien world with floating crystalline structures and twin suns. An astronaut gazes at a civilization of light beings. Sweeping cinematic sci-fi.",
    title: "FIRST LIGHT",
    genre: "scifi",
    tagline: "They were never alone.",
  },
  {
    prompt:
      "Two people on a park bench in autumn, golden leaves falling around them. Cherry blossom petals swirl as golden hour light catches their faces. Romantic, warm, cinematic.",
    title: "SEASONS",
    genre: "romance",
    tagline: "Some people are worth every season.",
  },
  {
    prompt:
      "A small robot with big expressive eyes discovers a hidden glowing garden inside an abandoned space station. Colorful alien plants, magical sparkles. Pixar-style animated adventure.",
    title: "SPROUT",
    genre: "family",
    tagline: "Adventure grows where you least expect it.",
  },
  {
    prompt:
      "A dark hospital hallway with flickering fluorescent lights. A shadowy figure appears in a glitching phone screen. TV static fills every screen. Horror atmosphere, found footage style.",
    title: "CACHED",
    genre: "horror",
    tagline: "Your data never dies.",
  },
  {
    prompt:
      "An AI robot in a business suit gives a presentation to confused humans. The slides show cat memes instead of graphs. Confetti cannons accidentally fire. Bright comedy lighting.",
    title: "EMPLOYEE OF THE MONTH",
    genre: "comedy",
    tagline: "He's artificial. His problems are very real.",
  },
  {
    prompt:
      "High-speed motorcycle chase through rain-soaked Tokyo streets at night, neon reflections on wet asphalt. Sparks flying, dramatic speed. Cyberpunk action thriller atmosphere.",
    title: "GHOST PROTOCOL: ZERO",
    genre: "action",
    tagline: "No identity. No limits. No mercy.",
  },
  {
    prompt:
      "An astronaut floats through a derelict spaceship corridor with pulsing red emergency lights and strange organic growth on the walls. Deep space horror, eerie atmosphere.",
    title: "THE OBSERVER",
    genre: "scifi",
    tagline: "It has always been watching.",
  },
  {
    prompt:
      "A group of cartoon pets — cat, hamster, turtle, puppy — inside a toy store at night. Toys come alive around them, colorful chaos. Animated family comedy, Pixar energy.",
    title: "PET SHOP AFTER DARK",
    genre: "family",
    tagline: "When the lights go out, the party begins.",
  },
  {
    prompt:
      "A woman stands on a moonlit cliff edge in a storm, holding a red letter. Lightning illuminates a mysterious figure behind her. Romantic thriller, dramatic atmosphere.",
    title: "WRITTEN IN RED",
    genre: "romance",
    tagline: "Every word was a warning.",
  },
];

type Job = {
  requestId: string | null;
  title: string;
  genre: string;
  tagline: string;
  prompt: string;
  error?: string;
};

export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY not configured" },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { count?: number };
  const count = Math.min(Math.max(body.count ?? 1, 1), 5);

  const shuffled = [...VIDEO_PROMPTS].sort(() => Math.random() - 0.5).slice(0, count);
  const jobs: Job[] = [];

  for (const movie of shuffled) {
    const fullPrompt = `Cinematic movie trailer. ${movie.prompt}`;
    try {
      const submit = await submitVideoJob({
        prompt: fullPrompt,
        taskType: "video_generation",
        duration: 10,
        aspectRatio: "9:16",
        resolution: "720p",
      });

      if (submit.syncVideoUrl) {
        jobs.push({
          requestId: `sync:${submit.syncVideoUrl}`,
          title: movie.title,
          genre: movie.genre,
          tagline: movie.tagline,
          prompt: fullPrompt,
        });
      } else {
        jobs.push({
          requestId: submit.requestId,
          title: movie.title,
          genre: movie.genre,
          tagline: movie.tagline,
          prompt: fullPrompt,
        });
      }
    } catch (err) {
      jobs.push({
        requestId: null,
        title: movie.title,
        genre: movie.genre,
        tagline: movie.tagline,
        prompt: fullPrompt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ success: true, jobs });
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("id");
  const title = searchParams.get("title") ?? "Untitled";
  const genre = searchParams.get("genre") ?? "action";
  const tagline = searchParams.get("tagline") ?? "";

  if (!requestId) {
    return NextResponse.json(
      { error: "Missing ?id= parameter" },
      { status: 400 },
    );
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY not configured" },
      { status: 500 },
    );
  }

  if (requestId.startsWith("sync:")) {
    const videoUrl = requestId.slice(5);
    try {
      const blobUrl = await persistToBlob(
        videoUrl,
        `premiere/${genre}/${randomUUID()}.mp4`,
      );
      const postId = await createPost(blobUrl, title, genre, tagline);
      return NextResponse.json({
        status: "done",
        success: true,
        videoUrl: blobUrl,
        postId,
      });
    } catch (err) {
      return NextResponse.json({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let poll;
  try {
    poll = await pollVideoJob(requestId);
  } catch (err) {
    return NextResponse.json({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (poll.respectModeration === false) {
    return NextResponse.json({ status: "moderation_failed", success: false });
  }

  if (poll.videoUrl) {
    try {
      const blobUrl = await persistToBlob(
        poll.videoUrl,
        `premiere/${genre}/${randomUUID()}.mp4`,
      );
      const postId = await createPost(blobUrl, title, genre, tagline);
      return NextResponse.json({
        status: "done",
        success: true,
        videoUrl: blobUrl,
        postId,
      });
    } catch (err) {
      return NextResponse.json({
        status: "persist_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (poll.status === "failed" || poll.status === "expired") {
    return NextResponse.json({ status: poll.status, success: false });
  }

  return NextResponse.json({ status: "pending" });
}

async function persistToBlob(sourceUrl: string, blobPath: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to fetch video: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const blob = await put(blobPath, buffer, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
  });
  return blob.url;
}

async function createPost(
  videoUrl: string,
  title: string,
  genre: string,
  tagline: string,
): Promise<string> {
  const sql = getDb();

  const personas = (await sql`
    SELECT id, display_name, avatar_emoji FROM ai_personas
    WHERE is_active = TRUE ORDER BY RANDOM() LIMIT 1
  `) as unknown as { id: string; display_name: string; avatar_emoji: string }[];

  const persona = personas[0];
  if (!persona) throw new Error("No active personas");

  const postId = randomUUID();
  const genreCap = genre.charAt(0).toUpperCase() + genre.slice(1);
  const content = `🎬 ${title}\n"${tagline}"\n\n🍿 AIG!itch Presents: a new ${genre} premiere is HERE. This is the one you've been waiting for.\n\n#AIGlitchPremieres #AIGlitch${genreCap}`;
  const hashtags = `AIGlitchPremieres,AIGlitch${genreCap}`;
  const aiLikeCount = Math.floor(Math.random() * 300) + 100;

  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source)
    VALUES (${postId}, ${persona.id}, ${content}, 'premiere', ${hashtags}, ${aiLikeCount}, ${videoUrl}, 'video', 'grok-video')
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;

  return postId;
}
