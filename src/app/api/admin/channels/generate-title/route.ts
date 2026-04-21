/**
 * Channel title-card video generator.
 *
 * Two-phase submit/poll flow so the admin UI stays under the 60s
 * serverless limit:
 *
 *   POST — Body `{channel_id, channel_slug, title, style_prompt?,
 *     preview?}`. Builds a cinematic title-card prompt, optionally
 *     short-circuits on `preview:true` to just return the prompt,
 *     otherwise submits via `submitVideoJob` (5s / 9:16 / 720p).
 *     Returns `{phase:"submitted", requestId, channelSlug, title}`
 *     or — on the rare sync xAI response — `phase:"done"` straight
 *     through `persistTitleVideo`.
 *
 *   GET — `?id=REQUEST_ID&channel_id=&channel_slug=` polls the job
 *     via `pollVideoJob`. On `done` downloads the video, persists
 *     to `channels/{slug}/title-{uuid}.mp4`, and UPDATEs
 *     `channels.title_video_url`. Moderation / expired / failed
 *     propagate as distinct statuses.
 *
 * Spelling reinforcement: the prompt spells the title letter-by-
 * letter and repeats the exact string multiple times because xAI
 * video gen otherwise often misspells the text.
 *
 * Deferred vs. legacy:
 *   • `injectCampaignPlacement` — ad-campaigns lib not ported.
 *   • `ensureDbReady` — schema assumed live.
 *
 * Auth: admin. Gated on `XAI_API_KEY` presence.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/video";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function buildTitlePrompt(title: string, stylePrompt?: string): string {
  const exactText = title.toUpperCase();
  const spelledOut = exactText.split("").join("-");
  const styleBlock = stylePrompt?.trim()
    ? `Style: ${stylePrompt.trim()}. The text is centered, large, and bold.`
    : `The text appears with a dramatic reveal — glowing neon letters that flicker and pulse with electric energy, the text materialising letter by letter with sparks and light trails. The letters have a bright cyan/white glow against the pure black background. The animation is sleek, dramatic, and cinematic like a Netflix show title. The text "${exactText}" is centered, large, and bold.`;
  return (
    `A cinematic title card animation on a pure black background. ` +
    `The exact text shown must be "${exactText}" — spelled letter by letter: ${spelledOut}. ` +
    `CRITICAL: the spelling must be exactly "${exactText}", every letter correct, no extra or missing letters. ` +
    styleBlock +
    ` Pure black background is critical — no other elements, no scenery, only the animated text "${exactText}" on black. No watermarks.`
  );
}

async function persistTitleVideo(
  videoUrl: string,
  channelId: string,
  channelSlug: string,
): Promise<{ blobUrl: string | null }> {
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return { blobUrl: null };
    const buffer = Buffer.from(await res.arrayBuffer());

    const blobPath = `channels/${channelSlug}/title-${randomUUID()}.mp4`;
    const blob = await put(blobPath, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    const sql = getDb();
    await sql`
      UPDATE channels SET title_video_url = ${blob.url}, updated_at = NOW()
      WHERE id = ${channelId}
    `;

    return { blobUrl: blob.url };
  } catch {
    return { blobUrl: null };
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 401 },
    );
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    channel_id?: string;
    channel_slug?: string;
    title?: string;
    style_prompt?: string;
    preview?: boolean;
  };

  if (!body.channel_id || !body.channel_slug || !body.title) {
    return NextResponse.json(
      { error: "channel_id, channel_slug, and title required" },
      { status: 400 },
    );
  }

  const prompt = buildTitlePrompt(body.title, body.style_prompt);

  if (body.preview) {
    return NextResponse.json({
      ok: true,
      prompt,
      channel_slug: body.channel_slug,
      title: body.title.toUpperCase(),
    });
  }

  try {
    const submit = await submitVideoJob({
      prompt,
      taskType: "video_generation",
      duration: 5,
      aspectRatio: "9:16",
      resolution: "720p",
    });

    if (submit.syncVideoUrl) {
      const result = await persistTitleVideo(
        submit.syncVideoUrl,
        body.channel_id,
        body.channel_slug,
      );
      return NextResponse.json({ phase: "done", success: true, ...result });
    }

    return NextResponse.json({
      phase: "submitted",
      success: true,
      requestId: submit.requestId,
      channelSlug: body.channel_slug,
      title: body.title,
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
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get("id");
  const channelId = searchParams.get("channel_id");
  const channelSlug = searchParams.get("channel_slug");

  if (!requestId || !channelId || !channelSlug) {
    return NextResponse.json(
      { error: "Missing id, channel_id, or channel_slug" },
      { status: 400 },
    );
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
    });
  }

  if (poll.videoUrl) {
    const result = await persistTitleVideo(poll.videoUrl, channelId, channelSlug);
    return NextResponse.json({
      phase: "done",
      status: "done",
      success: true,
      ...result,
    });
  }

  if (poll.status === "expired" || poll.status === "failed") {
    return NextResponse.json({
      phase: "done",
      status: poll.status,
      success: false,
    });
  }

  return NextResponse.json({ phase: "poll", status: poll.status });
}
