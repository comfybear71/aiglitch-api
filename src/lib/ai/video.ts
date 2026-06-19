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
 * Model selection (v1.51.1):
 *   - sourceImageUrl provided → `grok-imagine-video-1.5` (image-to-video,
 *     native synced audio, better motion + physics, ~2x faster).
 *   - sourceImageUrl absent (pure text prompt) → `grok-imagine-video`
 *     1.0. xAI's 1.5 model is image-to-video ONLY and returns
 *     400 "Text-to-video is not supported for this model." when called
 *     with just a prompt. 1.0 stays the fallback for text-to-video
 *     paths (chaos drops, breaking-news field/intro/outro, channel
 *     videos, sponsor cards) until xAI adds 1.5 text-to-video.
 *   - Explicit override: pass `opts.model = VIDEO_MODEL_V15` to force
 *     1.5 regardless. Only works with `sourceImageUrl`.
 *
 * To steer 1.5's audio output (SFX, ambience, brief dialogue), append
 * cues to the `prompt` string.
 *
 * Pricing: tiered by model + resolution (`costPerSecond(model, res)`).
 *
 *   1.0 @ 480p → $0.05/sec   1.5 @ 480p → $0.08/sec
 *   1.0 @ 720p → $0.07/sec   1.5 @ 720p → $0.14/sec
 *
 * Pre-v1.48.0 the ledger hardcoded $0.05/sec which under-reported every
 * 720p clip (= our default) by 40-180% depending on the model. Don't
 * compare cost-ledger numbers across the v1.48.0 boundary.
 *
 * Image-to-video payload shape changed in v1.48.0: was flat
 * `image_url: "<url>"`, now nested `image: { url: "<url>" }` — matches
 * the xAI docs as of 2026-06.
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

export const VIDEO_MODEL_V10 = "grok-imagine-video";
export const VIDEO_MODEL_V15 = "grok-imagine-video-1.5";
/** Default model used by all in-tree pipelines as of v1.48.0. */
export const VIDEO_MODEL: string = VIDEO_MODEL_V15;

/**
 * xAI video pricing per second, tiered by model + resolution.
 * Confirmed against docs.x.ai/developers/models as of 2026-06.
 * Returns 1.5 @ 720p ($0.14) as the safe default if either input is
 * unrecognised — we'd rather over-estimate than silently under-bill.
 */
export function costPerSecond(model: string, resolution: VideoResolution): number {
  if (model === VIDEO_MODEL_V10) {
    return resolution === "480p" ? 0.05 : 0.07;
  }
  if (model === VIDEO_MODEL_V15) {
    return resolution === "480p" ? 0.08 : 0.14;
  }
  // Unknown model — assume the most expensive current tier.
  return 0.14;
}

export type VideoAspectRatio = "9:16" | "16:9" | "1:1";
export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoStatus = "pending" | "done" | "failed" | "expired";

export interface SubmitVideoJobOptions {
  prompt: string;
  taskType: AiTaskType;
  /** Seconds. xAI supports up to 15s per clip on 1.5. Default 10. */
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  /** Image-to-video: URL of the source still frame. */
  sourceImageUrl?: string;
  /**
   * Override the model. Defaults to `VIDEO_MODEL` (currently 1.5). Use
   * `VIDEO_MODEL_V10` to opt back into the cheaper legacy model.
   */
  model?: string;
}

export interface SubmitVideoJobResult {
  requestId: string;
  /** Some xAI responses come back synchronously with the video attached. */
  syncVideoUrl?: string;
  model: string;
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
  model: string;
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
  model: string;
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
  // Grok Imagine Video 1.5 is image-to-video ONLY — text-to-video
  // submits return 400 "Text-to-video is not supported for this
  // model." When the caller didn't pass a sourceImageUrl, fall back
  // to the 1.0 model which still supports text-to-video. Callers
  // can opt into 1.5's improved motion + audio by either providing
  // an image OR explicitly setting `opts.model = VIDEO_MODEL_V15`
  // and supplying an image.
  const defaultModel = opts.sourceImageUrl ? VIDEO_MODEL_V15 : VIDEO_MODEL_V10;
  const model = opts.model ?? defaultModel;
  const resolution = opts.resolution ?? "720p";
  const payload: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    duration: durationSec,
    resolution,
  };
  if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;
  // Image-to-video payload shape changed in v1.48.0 to match xAI docs:
  // nested `image: { url }` instead of flat `image_url: string`.
  if (opts.sourceImageUrl) payload.image = { url: opts.sourceImageUrl };

  // ── Retry loop (v1.54.0) ────────────────────────────────────────
  //
  // xAI's grok-imagine-video model is rate-limited at 1 request/second
  // per team. Concurrent submits (breaking-news Mode A fires presenter
  // + field in parallel; chaos drops can collide with admin-triggered
  // ones) blow through that and surface as:
  //   { code: "resource-exhausted", error: "Too many requests ..." }
  //
  // Mirror the proven backoff in xai-extras.ts: retry transient
  // statuses (429 + 5xx) up to 3 times with 2s/4s/8s base + 0-500ms
  // jitter. Jitter is important — without it, two concurrent callers
  // that BOTH got 429 would both retry at exactly +2s and collide
  // again. Honors a Retry-After response header (seconds) when xAI
  // provides one. Other 4xx fail fast — 400 "text-to-video not
  // supported" or 401 "bad key" should NOT keep retrying.
  const MAX_RETRIES = 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
        const isTransient = res.status === 429 || res.status >= 500;
        if (isTransient && attempt < MAX_RETRIES) {
          const retryAfterHeader = res.headers?.get?.("retry-after") ?? null;
          const retryAfterSec = retryAfterHeader
            ? parseInt(retryAfterHeader, 10)
            : NaN;
          // Drain body so the connection can be reused; tiny memory cost.
          await res.text().catch(() => "");
          const baseMs =
            Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? retryAfterSec * 1000
              : Math.pow(2, attempt + 1) * 1000;
          const jitterMs = Math.floor(Math.random() * 500);
          const waitMs = baseMs + jitterMs;
          console.warn(
            `[xai/video] transient ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${(waitMs / 1000).toFixed(2)}s`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
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
      const estimatedUsd = durationSec * costPerSecond(model, resolution);
      await recordSuccess("xai");
      void logAiCost({
        provider: "xai",
        taskType: opts.taskType,
        model,
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd,
      });
      return {
        requestId: requestId ?? `sync-${Date.now()}`,
        syncVideoUrl,
        model,
        estimatedUsd,
        durationSec,
      };
    } catch (err) {
      // Network-level errors are transient — retry with backoff.
      // Errors we threw ourselves (non-OK status outside the retry
      // window, or missing request_id) bubble out.
      lastErr = err instanceof Error ? err : new Error(String(err));
      const isThrownByUs =
        lastErr.message.startsWith("xAI video submit failed") ||
        lastErr.message.startsWith("xAI video submit: response missing");
      if (!isThrownByUs && attempt < MAX_RETRIES) {
        const baseMs = Math.pow(2, attempt + 1) * 1000;
        const jitterMs = Math.floor(Math.random() * 500);
        console.warn(
          `[xai/video] network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastErr.message}; retrying in ${((baseMs + jitterMs) / 1000).toFixed(2)}s`,
        );
        await new Promise((r) => setTimeout(r, baseMs + jitterMs));
        continue;
      }
      await recordFailure("xai");
      throw lastErr;
    }
  }
  // Should be unreachable — the loop either returns on success or
  // throws on terminal failure inside the catch block.
  await recordFailure("xai");
  throw lastErr ?? new Error("xAI video submit failed after retries");
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
    // Force-trigger retries + cron re-runs hit the same blob path
    // (breaking-news brand assets keyed by intro/outro, chaos drops
    // keyed by scenario+uuid, etc.). Overwriting is safe — callers
    // either generate deterministic paths or include a random suffix
    // in the path itself.
    allowOverwrite: true,
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
