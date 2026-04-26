/**
 * Multi-Clip Video Series Generator
 *
 *   GET  — cron-auth'd. Polls pending multi-clip scenes, persists
 *          completed clips, stitches jobs whose every scene is done,
 *          returns counters + every job's status.
 *
 *   POST — admin-auth'd. Body:
 *            genre         drama / comedy / scifi / horror / family /
 *                          documentary / action / romance / music_video /
 *                          cooking_channel
 *            clips         2-6, default 4
 *            topic?        optional custom theme
 *            persona_id?   defaults to a random active persona
 *            aspect_ratio? "9:16" (default) or "16:9"
 *
 *          Generates a screenplay then submits each scene to Grok as
 *          an async video job. Returns the job id + screenplay summary;
 *          caller polls GET to see when the stitched final video is up.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import {
  generateScreenplay,
  getAvailableGenres,
  getMultiClipJobStatus,
  pollMultiClipJobs,
  submitMultiClipJobs,
} from "@/lib/media/multi-clip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const pollResult = await pollMultiClipJobs();
  const jobs = await getMultiClipJobStatus();

  return NextResponse.json({
    action: "polled",
    ...pollResult,
    jobs,
    availableGenres: getAvailableGenres(),
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY required for multi-clip video generation" },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    genre?: string;
    clips?: number;
    topic?: string;
    persona_id?: string;
    aspect_ratio?: "9:16" | "16:9";
  };

  const genre = body.genre ?? "drama";
  const clipCount = Math.min(Math.max(body.clips ?? 4, 2), 6);
  const aspectRatio = body.aspect_ratio ?? "9:16";

  const availableGenres = getAvailableGenres();
  if (!availableGenres.includes(genre)) {
    return NextResponse.json(
      {
        error: `Invalid genre: ${genre}. Available: ${availableGenres.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const sql = getDb();
  let personaId = body.persona_id;
  if (!personaId) {
    const rows = (await sql`
      SELECT id FROM ai_personas WHERE is_active = TRUE
      ORDER BY RANDOM() LIMIT 1
    `) as unknown as { id: string }[];
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "No active personas found" },
        { status: 400 },
      );
    }
    personaId = rows[0]!.id;
  }

  const screenplay = await generateScreenplay(genre, clipCount, body.topic);
  if (!screenplay) {
    return NextResponse.json(
      { error: "Screenplay generation failed" },
      { status: 500 },
    );
  }

  const jobId = await submitMultiClipJobs(screenplay, personaId, aspectRatio);
  if (!jobId) {
    return NextResponse.json(
      { error: "Failed to submit video jobs" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    screenplay: {
      title: screenplay.title,
      tagline: screenplay.tagline,
      synopsis: screenplay.synopsis,
      genre: screenplay.genre,
      clipCount: screenplay.clipCount,
      totalDuration: screenplay.totalDuration,
      scenes: screenplay.scenes.map((s) => ({
        sceneNumber: s.sceneNumber,
        title: s.title,
        description: s.description,
      })),
    },
    personaId,
    message: `Screenplay "${screenplay.title}" — ${screenplay.clipCount} scenes submitted to Grok. Poll GET /api/generate-series for progress.`,
  });
}
