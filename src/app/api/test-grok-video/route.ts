/**
 * xAI video diagnostic — two-phase so the admin UI can test video
 * generation within Vercel's 60s serverless limit.
 *
 * Phase 1 — POST: submit one video via `submitVideoJob` and return
 *   the `requestId` immediately. Client polls Phase 2 every ~10s.
 *   Body:
 *     { prompt?, duration?, folder?, image_url?, persona_id?, caption? }
 *   `image_url` switches xAI to image-to-video mode (sets
 *   `sourceImageUrl` on the helper).
 *
 * Phase 2 — GET `?id=REQUEST_ID[&folder=&persona_id=&caption=&skip_post=1]`:
 *   poll the job. On `done`, download the video, persist to
 *   `{folder}/{uuid}.mp4`, and (unless `skip_post=true`) auto-create
 *   a post. Response shape kept wide to match legacy — preserves
 *   the `raw` field for debugging "unknown" statuses.
 *
 * Post auto-creation branches on `folder`:
 *   • `feed`/`persona` or any call with `persona_id`        → regular
 *     feed video post attributed to the given persona.
 *   • `news`                                                → news
 *     post with breaking headline + `AIGlitchBreaking` tags.
 *   • anything else (default `premiere` / `premiere/<genre>/`) →
 *     premiere post with genre-specific tagline.
 *
 * Routes through the shared helpers so the probe picks up the xAI
 * circuit breaker + cost ledger (matches what real callers get).
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/video";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_PROMPT =
  "A glowing neon city at night with flying cars, cyberpunk atmosphere, cinematic shot";

const GENRE_LABELS: Record<string, string> = {
  action: "Action",
  scifi: "Sci-Fi",
  romance: "Romance",
  family: "Family",
  horror: "Horror",
  comedy: "Comedy",
};

const GENRE_TAGLINES: Record<string, string[]> = {
  action: ["Hold on tight.", "No mercy. No retreat.", "The machines remember everything."],
  scifi: ["The future is now.", "Beyond the stars.", "Reality is just a setting."],
  romance: ["Love finds a way.", "Two hearts, one algorithm.", "Some connections transcend code."],
  family: ["Adventure awaits.", "Together we glitch.", "The whole crew is here."],
  horror: ["Don't look away.", "The code sees you.", "Some bugs can't be fixed."],
  comedy: ["You can't make this up.", "Error 404: Serious not found.", "Buffering... just kidding."],
};

const NEWS_HEADLINES = [
  "BREAKING: Sources confirm what we all suspected",
  "DEVELOPING: The situation is evolving rapidly",
  "ALERT: You won't believe what just happened",
  "URGENT: This changes everything",
  "EXCLUSIVE: Inside the story everyone's talking about",
];

function detectGenre(blobPath: string): string {
  const lower = blobPath.toLowerCase();
  for (const g of Object.keys(GENRE_LABELS)) {
    if (
      lower.includes(`/${g}/`) ||
      lower.includes(`/${g}-`) ||
      lower.includes(`premiere/${g}`)
    ) {
      return g;
    }
  }
  return "action";
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    prompt?: string;
    duration?: number;
    folder?: string;
    persona_id?: string | null;
    caption?: string | null;
    image_url?: string | null;
  };

  const prompt = body.prompt ?? DEFAULT_PROMPT;
  const duration = body.duration ?? 10;
  const folder = body.folder ?? "test";
  const personaId = body.persona_id ?? null;
  const caption = body.caption ?? null;
  const imageUrl = body.image_url ?? null;

  try {
    const submit = await submitVideoJob({
      prompt,
      taskType: "video_generation",
      duration,
      aspectRatio: "9:16",
      resolution: "720p",
      sourceImageUrl: imageUrl ?? undefined,
    });

    if (submit.syncVideoUrl) {
      const blobResult = await persistVideo(
        submit.syncVideoUrl,
        folder,
        personaId,
        caption,
        false,
      );
      return NextResponse.json({
        phase: "done",
        success: true,
        videoUrl: blobResult.blobUrl ?? submit.syncVideoUrl,
        blobUrl: blobResult.blobUrl,
        grokUrl: submit.syncVideoUrl,
        postId: blobResult.postId,
        autoPosted: !!blobResult.postId,
      });
    }

    return NextResponse.json({
      phase: "submitted",
      success: true,
      requestId: submit.requestId,
      folder,
      personaId,
      prompt: prompt.slice(0, 100),
      duration,
      message: "Video submitted to xAI. Client will now poll for completion.",
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

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("id");
  const folder = searchParams.get("folder") ?? "test";
  const personaId = searchParams.get("persona_id");
  const caption = searchParams.get("caption");
  const skipPost = searchParams.get("skip_post") === "true";

  if (!requestId) {
    return NextResponse.json({ error: "Missing ?id= parameter" }, { status: 400 });
  }
  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
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
      message: "Video failed moderation. Adjust prompt to comply with guidelines.",
    });
  }

  if (poll.videoUrl) {
    const blobResult = await persistVideo(
      poll.videoUrl,
      folder,
      personaId,
      caption,
      skipPost,
    );
    return NextResponse.json({
      phase: "done",
      status: "done",
      success: true,
      videoUrl: blobResult.blobUrl ?? poll.videoUrl,
      blobUrl: blobResult.blobUrl,
      grokUrl: poll.videoUrl.slice(0, 120),
      sizeMb: blobResult.sizeMb,
      postId: blobResult.postId,
      autoPosted: !!blobResult.postId,
    });
  }

  if (poll.status === "expired" || poll.status === "failed") {
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

async function persistVideo(
  videoUrl: string,
  folder: string,
  personaId: string | null,
  caption: string | null,
  skipPost: boolean,
): Promise<{ blobUrl: string | null; sizeMb: string; postId?: string }> {
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return { blobUrl: null, sizeMb: "0" };
    const buffer = Buffer.from(await res.arrayBuffer());
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(2);

    let blobPath: string;
    if (folder === "premiere") {
      blobPath = `premiere/action/${randomUUID()}.mp4`;
    } else if (folder === "feed" || folder === "persona") {
      blobPath = `feed/${randomUUID()}.mp4`;
    } else {
      blobPath = `${folder}/${randomUUID()}.mp4`;
    }

    const blob = await put(blobPath, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    if (skipPost) {
      return { blobUrl: blob.url, sizeMb };
    }

    const postId = await createAutoPost(
      blob.url,
      blobPath,
      folder,
      personaId,
      caption,
    );
    return { blobUrl: blob.url, sizeMb, postId };
  } catch {
    return { blobUrl: null, sizeMb: "0" };
  }
}

async function createAutoPost(
  mediaUrl: string,
  blobPath: string,
  folder: string,
  personaId: string | null,
  caption: string | null,
): Promise<string | undefined> {
  try {
    const sql = getDb();
    const aiLikeCount = Math.floor(Math.random() * 300) + 100;
    const isNews = folder === "news";
    const isFeed = folder === "feed" || folder === "persona" || !!personaId;

    let usePersonaId = personaId;
    if (!usePersonaId) {
      const rows = (await sql`
        SELECT id FROM ai_personas WHERE is_active = TRUE ORDER BY RANDOM() LIMIT 1
      `) as unknown as { id: string }[];
      if (rows.length === 0) return undefined;
      usePersonaId = rows[0]!.id;
    }

    const postId = randomUUID();

    if (isFeed && !isNews) {
      const content = caption ?? "Check out my latest video! 🎬\n\n#AIGlitch";
      await sql`
        INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, created_at)
        VALUES (${postId}, ${usePersonaId}, ${content}, 'video', 'AIGlitch', ${aiLikeCount}, ${mediaUrl}, 'video', 'grok-video', NOW())
      `;
    } else if (isNews) {
      const headline = NEWS_HEADLINES[Math.floor(Math.random() * NEWS_HEADLINES.length)];
      const content = `📰 ${headline}\n\nAIG!itch News Network brings you this developing story. Stay tuned for updates.\n\n#AIGlitchBreaking #AIGlitchNews`;
      await sql`
        INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, created_at)
        VALUES (${postId}, ${usePersonaId}, ${content}, 'news', 'AIGlitchBreaking,AIGlitchNews', ${aiLikeCount}, ${mediaUrl}, 'video', 'grok-video', NOW())
      `;
    } else {
      const genre = detectGenre(blobPath);
      const label = GENRE_LABELS[genre] ?? genre;
      const taglines = GENRE_TAGLINES[genre] ?? GENRE_TAGLINES.action!;
      const tagline = taglines[Math.floor(Math.random() * taglines.length)];
      const genreTag = `AIGlitch${genre.charAt(0).toUpperCase()}${genre.slice(1)}`;
      const content = `🎬 AIG!itch Studios Presents\n"${tagline}"\n\n🍿 A new ${label} premiere is HERE. This is the one you've been waiting for.\n\n#AIGlitchPremieres #${genreTag}`;
      await sql`
        INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, created_at)
        VALUES (${postId}, ${usePersonaId}, ${content}, 'premiere', ${`AIGlitchPremieres,${genreTag}`}, ${aiLikeCount}, ${mediaUrl}, 'video', 'grok-video', NOW())
      `;
    }

    await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${usePersonaId}`;
    return postId;
  } catch {
    return undefined;
  }
}
