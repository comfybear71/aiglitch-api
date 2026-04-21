/**
 * xAI video generation helper — companion to `image.ts` for the
 * async / polling case. Four entry points:
 *
 *   submitVideoJob   — POST /videos/generations, returns `{ requestId }`.
 *   pollVideoJob     — GET /videos/{id}, returns the status once.
 *   generateVideo    — submit + poll-to-completion, returns the xAI URL.
 *   generateVideoToBlob — generateVideo + download + upload to Vercel Blob.
 *
 * Routes that want to hand a `requestId` back to the client (so the UI
 * can poll on its own — `generate-channel-video`, `extend-video`) call
 * `submitVideoJob` directly. One-shot flows (`hatch-admin`) use
 * `generateVideoToBlob`.
 *
 * Pricing: xAI bills `$0.05/second` flat for `grok-imagine-video`.
 *
 *   duration 5s  → $0.25
 *   duration 10s → $0.50
 *
 * Circuit breaker + cost ledger share the `"xai"` provider key with
 * text and image gen — one provider, one circuit. Accepted trade-off.
 *
 * Polling defaults: 10s interval, 90 attempts = 15 min ceiling. Matches
 * legacy behaviour. Tests override via `pollIntervalMs` + `maxAttempts`.
 */

import { put } from "@vercel/blob";
import { canProceed, recordFailure, recordSuccess } from "./circuit-breaker";
import { logAiCost } from "./cost-ledger";
import { XAI_BASE_URL } from "./xai";
import type { AiTaskType } from "./types";

export const VIDEO_MODEL = "grok-imagine-video";
export const VIDEO_COST_PER_SECOND_USD = 0.05;

export type VideoAspectRatio = "9:16" | "16:9" | "1:1";
export type VideoResolution = "720p" | "1080p";
export type VideoStatus = "pending" | "done" | "failed" | "expired";

export interface SubmitVideoJobOptions {
  prompt: string;
  taskType: AiTaskType;
  /** Seconds. xAI supports up to 10s per clip. Default 10. */
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  /** Image-to-video: URL of the source still frame. */
  sourceImageUrl?: string;
}

export interface SubmitVideoJobResult {
  requestId: string;
  /** Some xAI responses come back synchronously with the video attached. */
  syncVideoUrl?: string;
  model: typeof VIDEO_MODEL;
  /** Booked against the "xai" breaker + cost ledger at submit time. */
  estimatedUsd: number;
  durationSec: number;
}

export interface PollVideoJobResult {
  requestId: string;
  status: VideoStatus;
  videoUrl?: string;
  /** xAI may flag a completed video as moderation-blocked. */
  respectModeration?: boolean;
}

export interface GenerateVideoOptions extends SubmitVideoJobOptions {
  /** Milliseconds between poll attempts. Default 10,000. */
  pollIntervalMs?: number;
  /** Max poll attempts before giving up. Default 90. */
  maxAttempts?: number;
}

export interface GenerateVideoResult {
  videoUrl: string;
  requestId: string;
  model: typeof VIDEO_MODEL;
  estimatedUsd: number;
  durationSec: number;
}

export interface GenerateVideoToBlobOptions extends GenerateVideoOptions {
  blobPath: string;
  contentType?: string;
}

export interface GenerateVideoToBlobResult {
  blobUrl: string;
  requestId: string;
  model: typeof VIDEO_MODEL;
  estimatedUsd: number;
  durationSec: number;
  /** Size of the uploaded blob in bytes. */
  sizeBytes: number;
}

function apiKey(): string {
  const k = process.env.XAI_API_KEY;
  if (!k) throw new Error("XAI_API_KEY not set");
  return k;
}

export async function submitVideoJob(
  opts: SubmitVideoJobOptions,
): Promise<SubmitVideoJobResult> {
  if (!(await canProceed("xai"))) {
    throw new Error("xAI circuit breaker is OPEN");
  }
  const key = apiKey();
  const durationSec = opts.duration ?? 10;
  const payload: Record<string, unknown> = {
    model: VIDEO_MODEL,
    prompt: opts.prompt,
    duration: durationSec,
    resolution: opts.resolution ?? "720p",
  };
  if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;
  if (opts.sourceImageUrl) payload.image_url = opts.sourceImageUrl;

  try {
    const res = await fetch(`${XAI_BASE_URL}/videos/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `xAI video submit failed (${res.status}): ${detail.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      request_id?: string;
      video?: { url?: string };
    };
    const requestId = data.request_id;
    const syncVideoUrl = data.video?.url;
    if (!requestId && !syncVideoUrl) {
      throw new Error("xAI video submit: response missing request_id + video");
    }
    const estimatedUsd = durationSec * VIDEO_COST_PER_SECOND_USD;
    await recordSuccess("xai");
    void logAiCost({
      provider: "xai",
      taskType: opts.taskType,
      model: VIDEO_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd,
    });
    return {
      requestId: requestId ?? `sync-${Date.now()}`,
      syncVideoUrl,
      model: VIDEO_MODEL,
      estimatedUsd,
      durationSec,
    };
  } catch (err) {
    await recordFailure("xai");
    throw err;
  }
}

export async function pollVideoJob(requestId: string): Promise<PollVideoJobResult> {
  const key = apiKey();
  const res = await fetch(`${XAI_BASE_URL}/videos/${requestId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `xAI video poll failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    status?: VideoStatus;
    video?: { url?: string };
    respect_moderation?: boolean;
  };
  const status: VideoStatus = data.status ?? "pending";
  return {
    requestId,
    status,
    videoUrl: data.video?.url,
    respectModeration: data.respect_moderation,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateVideo(
  opts: GenerateVideoOptions,
): Promise<GenerateVideoResult> {
  const submit = await submitVideoJob(opts);
  if (submit.syncVideoUrl) {
    return {
      videoUrl: submit.syncVideoUrl,
      requestId: submit.requestId,
      model: submit.model,
      estimatedUsd: submit.estimatedUsd,
      durationSec: submit.durationSec,
    };
  }

  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const maxAttempts = opts.maxAttempts ?? 90;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);
    const poll = await pollVideoJob(submit.requestId);
    if (poll.status === "done") {
      if (poll.respectModeration === false) {
        throw new Error(
          `xAI video ${submit.requestId} blocked by moderation`,
        );
      }
      if (!poll.videoUrl) {
        throw new Error(
          `xAI video ${submit.requestId} done but missing url`,
        );
      }
      return {
        videoUrl: poll.videoUrl,
        requestId: submit.requestId,
        model: submit.model,
        estimatedUsd: submit.estimatedUsd,
        durationSec: submit.durationSec,
      };
    }
    if (poll.status === "failed" || poll.status === "expired") {
      throw new Error(
        `xAI video ${submit.requestId} ${poll.status}`,
      );
    }
  }
  throw new Error(
    `xAI video ${submit.requestId} still pending after ${maxAttempts} attempts`,
  );
}

export async function generateVideoToBlob(
  opts: GenerateVideoToBlobOptions,
): Promise<GenerateVideoToBlobResult> {
  const { videoUrl, requestId, model, estimatedUsd, durationSec } =
    await generateVideo(opts);

  const vidRes = await fetch(videoUrl);
  if (!vidRes.ok) {
    throw new Error(`Failed to download xAI video (${vidRes.status})`);
  }
  const vidBuffer = Buffer.from(await vidRes.arrayBuffer());
  const contentType =
    opts.contentType ?? vidRes.headers.get("content-type") ?? "video/mp4";

  const blob = await put(opts.blobPath, vidBuffer, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });

  return {
    blobUrl: blob.url,
    requestId,
    model,
    estimatedUsd,
    durationSec,
    sizeBytes: vidBuffer.length,
  };
}
