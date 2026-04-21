/**
 * xAI image generation helper.
 *
 * Mirrors the text-completion helpers: circuit-breaker gated (shared
 * `"xai"` provider key — image failures open the same breaker as text),
 * fire-and-forget cost ledger. Two entry points:
 *
 *   generateImage        — low-level: returns the ephemeral xAI URL.
 *   generateImageToBlob  — generates + immediately downloads + uploads to
 *                          Vercel Blob; returns the persistent blob URL.
 *                          xAI URLs expire fast, so this is what most
 *                          admin routes want.
 *
 * Pricing (xAI published rates, flat per image):
 *   grok-imagine-image       — $0.02
 *   grok-imagine-image-pro   — $0.07
 *
 * `blobPath` is used verbatim (no random suffix) so UPSERT flows
 * (product id → deterministic path) keep working.
 */

import { put } from "@vercel/blob";
import { canProceed, recordFailure, recordSuccess } from "./circuit-breaker";
import { logAiCost } from "./cost-ledger";
import { XAI_BASE_URL } from "./xai";
import type { AiTaskType } from "./types";

export type ImageModel = "grok-imagine-image" | "grok-imagine-image-pro";
export type AspectRatio = "1:1" | "9:16" | "16:9";

const COST_PER_IMAGE: Record<ImageModel, number> = {
  "grok-imagine-image": 0.02,
  "grok-imagine-image-pro": 0.07,
};

export interface GenerateImageOptions {
  prompt: string;
  taskType: AiTaskType;
  model?: ImageModel;
  aspectRatio?: AspectRatio;
  /** When set, routes to `/images/edits` with the source URLs attached. */
  sourceImageUrls?: string[];
}

export interface GenerateImageResult {
  imageUrl: string;
  model: ImageModel;
  estimatedUsd: number;
}

export async function generateImage(
  opts: GenerateImageOptions,
): Promise<GenerateImageResult> {
  if (!(await canProceed("xai"))) {
    throw new Error("xAI circuit breaker is OPEN");
  }
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY not set");

  const model = opts.model ?? "grok-imagine-image";
  const endpoint = opts.sourceImageUrls?.length
    ? `${XAI_BASE_URL}/images/edits`
    : `${XAI_BASE_URL}/images/generations`;

  const payload: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n: 1,
  };
  if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;
  if (opts.sourceImageUrls?.length) {
    payload.images = opts.sourceImageUrls.map((url) => ({ url }));
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `xAI image gen failed (${res.status}): ${detail.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as {
      data?: { url?: string; b64_json?: string }[];
    };
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) throw new Error("xAI image gen: no URL in response");

    const estimatedUsd = COST_PER_IMAGE[model];
    await recordSuccess("xai");
    void logAiCost({
      provider: "xai",
      taskType: opts.taskType,
      model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd,
    });

    return { imageUrl, model, estimatedUsd };
  } catch (err) {
    await recordFailure("xai");
    throw err;
  }
}

export interface GenerateImageToBlobOptions extends GenerateImageOptions {
  blobPath: string;
  contentType?: string;
}

export interface GenerateImageToBlobResult {
  blobUrl: string;
  model: ImageModel;
  estimatedUsd: number;
}

export async function generateImageToBlob(
  opts: GenerateImageToBlobOptions,
): Promise<GenerateImageToBlobResult> {
  const { imageUrl, model, estimatedUsd } = await generateImage(opts);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download xAI image (${imgRes.status})`);
  }
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  const contentType =
    opts.contentType ?? imgRes.headers.get("content-type") ?? "image/png";

  const blob = await put(opts.blobPath, imgBuffer, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });

  return { blobUrl: blob.url, model, estimatedUsd };
}
