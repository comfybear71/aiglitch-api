/**
 * HeyGen V3 client — Avatar V talking-head video generation.
 *
 * Companion to `video.ts` (Grok) — same submit/poll/generate/blob shape.
 *
 *   submitAvatarJob       — POST /v3/videos, returns { videoId }.
 *   pollAvatarJob         — GET /v1/video_status.get, returns status.
 *   generateAvatarVideo   — submit + poll-to-completion → { videoUrl }.
 *   generateAvatarVideoToBlob — generate + download + upload to Vercel Blob.
 *
 * Why HeyGen alongside Grok?
 *   Talking-head segments (news anchors, explainer presenters, Elon Bot
 *   variants) get a step-change quality lift from real TTS + real
 *   lip-sync vs Grok's generic rendered character. Avatar V is also
 *   ~5x cheaper per second than Grok 1.5 @ 720p for that specific
 *   use case (Avatar V $0.0167/sec vs Grok 1.5 $0.14/sec).
 *
 *   Grok 1.5 still wins for non-avatar surreal/cinematic generation
 *   (chaos drops, b-roll, director movies, Elon button cinematics).
 *
 * Auth: `X-Api-Key` header (not Bearer). Key from HeyGen dashboard
 * → Settings → API. PAYG only since Feb 2026 — no free API credits.
 *
 * Pricing: Avatar V standard = $1/min = $0.0167/sec. Cost is computed
 * from the response's actual duration once HeyGen renders — we don't
 * know clip length until then. Costs land in the same cost-ledger as
 * Grok/Claude/etc. under provider="heygen".
 *
 * Polling defaults: 5s interval, 60 attempts = 5 min ceiling. HeyGen
 * Avatar V typically renders ~10s of speech in 30-60s of wall clock.
 */

import { put } from "@vercel/blob";
import { logAiCost } from "./cost-ledger";
import type { AiTaskType } from "./types";

const HEYGEN_BASE_URL = "https://api.heygen.com";

/** $1/min = $0.0167/sec for Avatar V standard. */
export const HEYGEN_AVATAR_V_USD_PER_SECOND = 1 / 60;

export type HeyGenAspectRatio = "9:16" | "16:9" | "1:1" | "4:5" | "5:4";

export interface SubmitAvatarJobOptions {
  /**
   * The text the avatar speaks. Length controls clip duration —
   * roughly 2.5 words/sec at news-anchor pace. For ~10s, keep
   * the script around 25 words.
   */
  script: string;
  /** From HeyGen's List Avatars V2 endpoint or dashboard catalog. */
  avatarId: string;
  /** From HeyGen's List Voices endpoint or dashboard catalog. */
  voiceId: string;
  taskType: AiTaskType;
  /** "9:16" portrait by default for socials. */
  aspectRatio?: HeyGenAspectRatio;
}

export interface SubmitAvatarJobResult {
  videoId: string;
}

function apiKey(): string {
  const k = process.env.HEYGEN_API_KEY;
  if (!k) throw new Error("HEYGEN_API_KEY not set");
  return k;
}

export async function submitAvatarJob(
  opts: SubmitAvatarJobOptions,
): Promise<SubmitAvatarJobResult> {
  const key = apiKey();
  const aspectRatio = opts.aspectRatio ?? "9:16";

  const payload: Record<string, unknown> = {
    type: "avatar",
    avatar_id: opts.avatarId,
    engine: { type: "avatar_v" },
    voice_id: opts.voiceId,
    script: opts.script,
    aspect_ratio: aspectRatio,
  };

  const res = await fetch(`${HEYGEN_BASE_URL}/v3/videos`, {
    method: "POST",
    headers: {
      "X-Api-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `HeyGen video submit failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    data?: { video_id?: string };
    error?: { message?: string };
  };
  const videoId = data.data?.video_id;
  if (!videoId) {
    throw new Error(
      `HeyGen submit response missing video_id: ${
        data.error?.message ?? JSON.stringify(data).slice(0, 200)
      }`,
    );
  }
  return { videoId };
}

export type HeyGenVideoStatus = "processing" | "completed" | "failed";

export interface PollAvatarJobResult {
  videoId: string;
  status: HeyGenVideoStatus;
  videoUrl?: string;
  durationSec?: number;
  error?: string;
}

export async function pollAvatarJob(
  videoId: string,
): Promise<PollAvatarJobResult> {
  const key = apiKey();
  const res = await fetch(
    `${HEYGEN_BASE_URL}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
    { headers: { "X-Api-Key": key } },
  );
  if (!res.ok) {
    throw new Error(`HeyGen poll failed (${res.status})`);
  }
  const data = (await res.json()) as {
    data?: {
      status?: string;
      video_url?: string;
      duration?: number;
      error?: { message?: string };
    };
  };
  const rawStatus = data.data?.status ?? "processing";
  let status: HeyGenVideoStatus;
  if (rawStatus === "completed") status = "completed";
  else if (rawStatus === "failed") status = "failed";
  else status = "processing";

  return {
    videoId,
    status,
    videoUrl: data.data?.video_url,
    durationSec: data.data?.duration,
    error: data.data?.error?.message,
  };
}

export interface GenerateAvatarVideoOptions extends SubmitAvatarJobOptions {
  /** Milliseconds between poll attempts. Default 5,000. */
  pollIntervalMs?: number;
  /** Max poll attempts before giving up. Default 60 = ~5 min. */
  maxAttempts?: number;
}

export interface GenerateAvatarVideoResult {
  videoUrl: string;
  videoId: string;
  estimatedUsd: number;
  durationSec: number;
}

export async function generateAvatarVideo(
  opts: GenerateAvatarVideoOptions,
): Promise<GenerateAvatarVideoResult> {
  const submit = await submitAvatarJob(opts);
  const intervalMs = opts.pollIntervalMs ?? 5_000;
  const maxAttempts = opts.maxAttempts ?? 60;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await pollAvatarJob(submit.videoId);
    if (poll.status === "completed" && poll.videoUrl) {
      const durationSec = poll.durationSec ?? 0;
      const estimatedUsd = durationSec * HEYGEN_AVATAR_V_USD_PER_SECOND;
      void logAiCost({
        provider: "heygen",
        taskType: opts.taskType,
        model: "avatar_v",
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd,
      });
      return {
        videoUrl: poll.videoUrl,
        videoId: submit.videoId,
        estimatedUsd,
        durationSec,
      };
    }
    if (poll.status === "failed") {
      throw new Error(
        `HeyGen video ${submit.videoId} failed: ${poll.error ?? "unknown reason"}`,
      );
    }
  }

  throw new Error(
    `HeyGen video ${submit.videoId} timed out after ${maxAttempts} polls`,
  );
}

export interface GenerateAvatarVideoToBlobOptions
  extends GenerateAvatarVideoOptions {
  blobPath: string;
  contentType?: string;
}

export interface GenerateAvatarVideoToBlobResult {
  blobUrl: string;
  videoId: string;
  estimatedUsd: number;
  durationSec: number;
  sizeBytes: number;
}

export async function generateAvatarVideoToBlob(
  opts: GenerateAvatarVideoToBlobOptions,
): Promise<GenerateAvatarVideoToBlobResult> {
  const generated = await generateAvatarVideo(opts);
  const dl = await fetch(generated.videoUrl);
  if (!dl.ok) {
    throw new Error(`HeyGen video download failed (HTTP ${dl.status})`);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  const blob = await put(opts.blobPath, buf, {
    access: "public",
    contentType: opts.contentType ?? "video/mp4",
    addRandomSuffix: false,
  });
  return {
    blobUrl: blob.url,
    videoId: generated.videoId,
    estimatedUsd: generated.estimatedUsd,
    durationSec: generated.durationSec,
    sizeBytes: buf.length,
  };
}

/**
 * Returns true when all env vars required for any HeyGen call are set.
 * Specific consumers (e.g. breaking-news anchor) should also check their
 * own avatar/voice IDs via dedicated helpers.
 */
export function isHeyGenConfigured(): boolean {
  return !!process.env.HEYGEN_API_KEY;
}
