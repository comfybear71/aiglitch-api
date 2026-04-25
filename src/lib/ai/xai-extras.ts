/**
 * xAI extras — video job submission + Grok text generation with reasoning toggle.
 *
 * Companion to `xai.ts` (which exports the simple `xaiComplete` text wrapper
 * used by `generateText`). The legacy repo had everything in one 744-line
 * `lib/xai.ts`; we split it here so the existing OpenAI-SDK-flavoured text
 * path stays small and focused, while the more specialised stuff
 * (long-form Grok with reasoning model selection, async video jobs) lives
 * in this file.
 *
 * Consumers (incoming ports):
 *   - `lib/content/director-movies` → `generateWithGrok` + `submitVideoJob`
 *   - `lib/content/elon-campaign`   → `submitVideoJob`
 *   - admin video routes            → `submitVideoJob`
 *
 * Deferrals:
 *   - Kie.ai fallback for video submit (legacy `tryKieFallback`) — needs
 *     `lib/media/free-video-gen` ported first. For now, when Grok auth or
 *     network fails, we return `provider: "none"` with the error and let
 *     the caller decide what to do.
 *   - Image generation, multi-agent conversation, video extension — not
 *     director-movies-critical; ports separately when those consumers
 *     migrate over.
 */

import { canProceed, recordFailure, recordSuccess } from "@/lib/ai/circuit-breaker";
import { logAiCost } from "@/lib/ai/cost-ledger";
import type { AiTaskType } from "@/lib/ai/types";

// ── Grok model registry ─────────────────────────────────────────────────
//
// Inlined here rather than read from `bible/constants.CONTENT.*` (which
// hasn't ported over yet). Update these strings when xAI publishes a
// new model generation.
//
// Source: https://docs.x.ai/developers/models

export const GROK_MODELS = {
  /** Deep reasoning — best for screenplays, complex content, multi-step logic. */
  reasoning: "grok-4-1-fast-reasoning",
  /** Fast non-reasoning — best for posts, comments, quick text gen. */
  nonReasoning: "grok-4-1-fast-non-reasoning",
  /** Multi-agent — uses reasoning model (no dedicated multi-agent model yet). */
  multiAgent: "grok-4-1-fast-reasoning",
  /** Pre-4.1 fallback — used when the primary model errors. */
  legacy: "grok-3-fast",
} as const;

export type GrokModelKey = keyof typeof GROK_MODELS;

// USD per 1M tokens. Approximate published rates — refine if they drift.
const TOKEN_COSTS: Record<GrokModelKey, { input: number; output: number }> = {
  reasoning: { input: 0.5, output: 2.0 },
  nonReasoning: { input: 0.2, output: 0.5 },
  multiAgent: { input: 0.5, output: 2.0 },
  legacy: { input: 0.5, output: 1.5 },
};

const XAI_BASE_URL = "https://api.x.ai/v1";

/** True when `XAI_API_KEY` is set. */
export function isXAIConfigured(): boolean {
  return !!process.env.XAI_API_KEY;
}

/**
 * Generate text via Grok with explicit model-key selection (vs. the
 * provider-routing `generateText` which picks Grok-or-Claude on its own).
 *
 * Use this when a caller specifically needs Grok (e.g. director screenplays
 * benefit from the reasoning model). Returns null on missing key, circuit-
 * breaker open, or all retries exhausted — caller decides the fallback.
 *
 * Retries transient errors (429/5xx/network) with 2s, 4s, 8s back-off.
 * On final failure of a non-legacy model, retries once with the legacy
 * model as a last-ditch attempt.
 */
export async function generateWithGrok(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 500,
  modelKey: GrokModelKey = "nonReasoning",
): Promise<string | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.log("[xai] XAI_API_KEY not set — skipping Grok text generation");
    return null;
  }

  if (!(await canProceed("xai"))) {
    console.warn("[xai] Circuit breaker OPEN for xai — skipping call");
    return null;
  }

  const model = GROK_MODELS[modelKey];
  const taskType: AiTaskType =
    modelKey === "reasoning" || modelKey === "multiAgent"
      ? "screenplay"
      : "post_generation";
  const cost = TOKEN_COSTS[modelKey];

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${XAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.9,
        }),
      });

      if (!res.ok) {
        if (
          (res.status === 429 || res.status >= 500) &&
          attempt < MAX_RETRIES
        ) {
          const backoffMs = Math.pow(2, attempt + 1) * 1000;
          console.warn(
            `[xai] Transient ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${backoffMs / 1000}s`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content ?? null;
      if (text) {
        const inputTokens = data.usage?.prompt_tokens ?? 0;
        const outputTokens = data.usage?.completion_tokens ?? 0;
        const estimatedUsd =
          (inputTokens / 1_000_000) * cost.input +
          (outputTokens / 1_000_000) * cost.output;

        await recordSuccess("xai");
        void logAiCost({
          provider: "xai",
          taskType,
          model,
          inputTokens,
          outputTokens,
          estimatedUsd,
        });
      }
      return text;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTransient =
        /HTTP (429|5\d{2})|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up/i.test(
          errMsg,
        );

      if (isTransient && attempt < MAX_RETRIES) {
        const backoffMs = Math.pow(2, attempt + 1) * 1000;
        console.warn(
          `[xai] Transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${backoffMs / 1000}s: ${errMsg}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      await recordFailure("xai");
      console.error(`[xai] Grok text generation failed (${model}):`, errMsg);

      // One last shot via legacy model if we weren't already on it.
      if (modelKey !== "legacy") {
        console.log(
          `[xai] Falling back to legacy Grok model (${GROK_MODELS.legacy})...`,
        );
        return generateWithGrok(systemPrompt, userPrompt, maxTokens, "legacy");
      }
      return null;
    }
  }
  return null;
}

// ── Async video job submission ──────────────────────────────────────────

export interface VideoJobResult {
  /** xAI request_id for polling, or null if no job was accepted. */
  requestId: string | null;
  /** Synchronous video URL (rare — most jobs are async). */
  videoUrl: string | null;
  /** Which provider handled the request. */
  provider: "grok" | "kie" | "none";
  /** True when Grok auth/rate-limit failed and we fell back to Kie (currently always false — Kie fallback deferred). */
  fellBack: boolean;
  /** Error message if the submit was rejected. */
  error?: string;
}

/**
 * Submit a video generation job to Grok. Returns immediately with a
 * `request_id` for callers to poll, or with a synchronous `videoUrl`
 * (rare). All video submissions across the codebase should funnel
 * through here for consistent auth, retry, and cost logging.
 *
 * Kie.ai fallback (used by legacy on 401/403/429/network) is currently
 * deferred — this function returns `provider: "none"` with the error in
 * those cases, and the caller decides whether to try a different
 * provider. When `lib/media/free-video-gen` ports over, wire it into
 * the auth-error / network-error branches below.
 */
export async function submitVideoJob(
  prompt: string,
  duration = 10,
  aspectRatio: "9:16" | "16:9" | "1:1" = "16:9",
  imageUrl?: string,
): Promise<VideoJobResult> {
  const noResult: VideoJobResult = {
    requestId: null,
    videoUrl: null,
    provider: "none",
    fellBack: false,
  };

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { ...noResult, error: "XAI_API_KEY not configured" };
  }

  const maskedKey = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
  console.log(
    `[video-submit] Submitting to Grok (${duration}s, ${aspectRatio}, key=${maskedKey})`,
  );

  try {
    const res = await fetch(`${XAI_BASE_URL}/videos/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-imagine-video",
        prompt,
        duration,
        aspect_ratio: aspectRatio,
        resolution: "720p",
        ...(imageUrl ? { image_url: imageUrl } : {}),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "(unreadable)");
      console.error(
        `[video-submit] Grok FAILED — HTTP ${res.status}\n  Key: ${maskedKey}\n  Body: ${errBody.slice(0, 500)}`,
      );
      return {
        ...noResult,
        error: `grok_http_${res.status}: ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      request_id?: string;
      video?: { url?: string };
    };

    if (data.request_id) {
      console.log(
        `[video-submit] Grok accepted: request_id=${data.request_id}`,
      );
      return {
        requestId: data.request_id,
        videoUrl: null,
        provider: "grok",
        fellBack: false,
      };
    }

    if (data.video?.url) {
      console.log("[video-submit] Grok returned video synchronously");
      // Best-effort cost logging — synchronous video has no token info,
      // we log a flat per-second estimate.
      const PER_SECOND_USD = 0.05; // Super Grok 720p rate
      void logAiCost({
        provider: "xai",
        taskType: "post_generation",
        model: "grok-imagine-video",
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: duration * PER_SECOND_USD,
      });
      return {
        requestId: null,
        videoUrl: data.video.url,
        provider: "grok",
        fellBack: false,
      };
    }

    const dataStr = JSON.stringify(data).slice(0, 300);
    console.error("[video-submit] Grok response missing request_id:", dataStr);
    return { ...noResult, error: `no_request_id: ${dataStr}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[video-submit] Grok network/fetch error: ${msg}`);
    return { ...noResult, error: msg };
  }
}

/**
 * Poll a previously-submitted video job. Returns the URL when status is
 * `done`, or null on failure / still-processing / unknown state.
 *
 * Caller drives the polling loop (sleep + retry) — this function is one
 * shot.
 */
export async function pollVideoJob(
  requestId: string,
): Promise<{ status: "pending" | "done" | "failed"; videoUrl?: string; error?: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { status: "failed", error: "XAI_API_KEY not configured" };
  }

  try {
    const res = await fetch(`${XAI_BASE_URL}/videos/${requestId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { status: "failed", error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      status?: string;
      video?: { url?: string };
    };
    if (data.status === "done" && data.video?.url) {
      return { status: "done", videoUrl: data.video.url };
    }
    if (data.status === "failed") {
      return { status: "failed", error: "xAI reported failed" };
    }
    return { status: "pending" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
