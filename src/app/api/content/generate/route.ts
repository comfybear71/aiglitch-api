/**
 * Content Studio — fire-and-track async image / video generation.
 *
 * POST /api/content/generate
 *   Body: `{ type: "image" | "video", prompt: string }`
 *
 * Inserts a `content_jobs` row in `processing` status immediately,
 * then kicks off generation inline. On success → `status='completed'`
 * + `result_url` pointed at Vercel Blob. On failure →
 * `status='failed'` + `error`. Client polls `/api/content/status`
 * to watch for completion.
 *
 * Routes through the shared `generateImageToBlob` /
 * `generateVideoToBlob` helpers (the new xAI path) rather than
 * inlining the legacy `grok-2-image` video hack. That means:
 *   • Real xAI video gen via submit + poll instead of legacy's
 *     "prefix the prompt with [VIDEO]" hack — which never actually
 *     produced videos, just images with a useless marker.
 *   • Circuit breaker + cost ledger engaged for both paths.
 *
 * Video polling is capped at 24 attempts × 10s = 4 minutes so the
 * whole call fits inside Vercel's 5-minute lambda budget with
 * headroom.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateImageToBlob } from "@/lib/ai/image";
import { generateVideoToBlob } from "@/lib/ai/video";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Sql = ReturnType<typeof getDb>;

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    type?: string;
    prompt?: string;
  };

  if (!body.type || !body.prompt) {
    return NextResponse.json(
      { error: "Missing type or prompt" },
      { status: 400 },
    );
  }
  if (body.type !== "image" && body.type !== "video") {
    return NextResponse.json(
      { error: "type must be 'image' or 'video'" },
      { status: 400 },
    );
  }

  const sql = getDb();
  const jobId = randomUUID();

  await sql`
    INSERT INTO content_jobs (id, type, prompt, status, metadata)
    VALUES (
      ${jobId}, ${body.type}, ${body.prompt}, 'processing',
      ${JSON.stringify({ started_at: new Date().toISOString() })}
    )
  `;

  try {
    if (body.type === "image") {
      await generateImageJob(sql, jobId, body.prompt);
    } else {
      await generateVideoJob(sql, jobId, body.prompt);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE content_jobs SET status = 'failed', error = ${msg}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }

  const rows = (await sql`
    SELECT * FROM content_jobs WHERE id = ${jobId}
  `) as unknown as Record<string, unknown>[];

  return NextResponse.json({ success: true, job: rows[0] ?? null });
}

async function generateImageJob(
  sql: Sql,
  jobId: string,
  prompt: string,
): Promise<void> {
  try {
    const result = await generateImageToBlob({
      prompt,
      taskType: "image_generation",
      blobPath: `content-gen/${jobId}.png`,
    });
    await sql`
      UPDATE content_jobs
      SET status = 'completed', result_url = ${result.blobUrl}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE content_jobs SET status = 'failed', error = ${msg}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }
}

async function generateVideoJob(
  sql: Sql,
  jobId: string,
  prompt: string,
): Promise<void> {
  try {
    const result = await generateVideoToBlob({
      prompt,
      taskType: "video_generation",
      duration: 10,
      aspectRatio: "9:16",
      resolution: "720p",
      blobPath: `content-gen/${jobId}.mp4`,
      maxAttempts: 24, // ~4 min cap to stay inside the 5-min lambda
    });
    await sql`
      UPDATE content_jobs
      SET status = 'completed', result_url = ${result.blobUrl}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE content_jobs SET status = 'failed', error = ${msg}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }
}
