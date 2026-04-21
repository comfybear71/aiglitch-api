/**
 * Media pipeline diagnostic — exercises the three xAI media helpers
 * (`generateImage`, `generateImageToBlob`, `submitVideoJob`) with a
 * canned prompt and returns per-step results for the admin ops page.
 *
 * Intended to replace legacy's `testMediaPipeline` (which lived in the
 * legacy `@/lib/media/image-gen` and tried OpenAI / Replicate / Kie
 * fallbacks). The new repo is xAI-only so this probe is a narrower
 * "are our three xAI paths alive" check. Each step is captured
 * independently so a failing step doesn't abort the whole probe.
 *
 * GET — Admin-authed. Returns `{ image, imageToBlob, videoSubmit }`
 *       objects with per-step success / error.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateImage, generateImageToBlob } from "@/lib/ai/image";
import { submitVideoJob } from "@/lib/ai/video";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const IMAGE_PROMPT =
  "A chrome robot holds up a glowing AIG!itch badge. Cinematic lighting, 1:1 square, bright saturated colors.";
const VIDEO_PROMPT =
  "A figure leaps from a neon skyscraper at night, coat flowing. 9:16 cinematic, 720p.";

type StepResult =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; error: string };

async function tryStep(run: () => Promise<Record<string, unknown>>): Promise<StepResult> {
  try {
    const detail = await run();
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY not set", hasKey: false },
      { status: 500 },
    );
  }

  const [image, imageToBlob, videoSubmit] = await Promise.all([
    tryStep(async () => {
      const r = await generateImage({
        prompt: IMAGE_PROMPT,
        taskType: "image_generation",
      });
      return {
        imageUrl: r.imageUrl,
        model: r.model,
        estimatedUsd: r.estimatedUsd,
      };
    }),
    tryStep(async () => {
      const r = await generateImageToBlob({
        prompt: IMAGE_PROMPT,
        taskType: "image_generation",
        aspectRatio: "1:1",
        blobPath: `diagnostic/media-${Date.now()}.png`,
      });
      return {
        blobUrl: r.blobUrl,
        model: r.model,
        estimatedUsd: r.estimatedUsd,
      };
    }),
    tryStep(async () => {
      const r = await submitVideoJob({
        prompt: VIDEO_PROMPT,
        taskType: "video_generation",
        duration: 10,
        aspectRatio: "9:16",
        resolution: "720p",
      });
      return {
        requestId: r.requestId,
        syncVideoUrl: r.syncVideoUrl ?? null,
        model: r.model,
        estimatedUsd: r.estimatedUsd,
        durationSec: r.durationSec,
      };
    }),
  ]);

  const allOk = image.ok && imageToBlob.ok && videoSubmit.ok;

  return NextResponse.json({
    ok: allOk,
    image,
    imageToBlob,
    videoSubmit,
  });
}
