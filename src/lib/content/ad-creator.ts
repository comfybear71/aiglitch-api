/**
 * Ad Creator — generation pipeline.
 *
 * Brief → Claude script → HeyGen anchor + Grok b-roll (parallel) →
 * ffmpeg stitch → Vercel Blob → INSERT post to For You feed → update
 * brief diagnostic columns.
 *
 * Triggered by POST /api/admin/ads/[id]/generate. Sync — caller awaits
 * the full pipeline within the Vercel function maxDuration.
 *
 * What we learned the hard way from breaking-news Mode B (v1.49-v1.51):
 *   1. xAI Grok 1.5 is image-to-video ONLY — text-only prompts return
 *      400. `generateVideoToBlob` auto-routes text prompts to 1.0; we
 *      rely on that and pass only text per-scene.
 *   2. Next 16 strips native binaries from the lambda by default —
 *      next.config.ts pins ffmpeg-static via both serverExternalPackages
 *      and outputFileTracingIncludes (the /api/admin/ads/[id]/generate
 *      route is listed there).
 *   3. Vercel Blob refuses overwrites without `allowOverwrite: true`.
 *      Generation paths are deterministic by brief id + timestamp so
 *      retries are safe; the helpers handle this.
 *   4. mp4-concat byte-level stitching fails on mixed-codec input.
 *      We use the ffmpeg-stitch helper which re-encodes to a common
 *      H.264 baseline profile before concat.
 *   5. Diagnostic surfaces are the killer feature. Every generation
 *      result lands in the brief's `generation_log` / `last_error`
 *      columns so the operator can debug from a browser without
 *      Vercel log diving.
 *
 * Cost cap: configurable per-call via `maxCostUsd` option, default $5.
 * A pre-flight check bails if estimated cost exceeds the cap — better
 * to refuse upfront than to blow the budget halfway through a stitch.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { generateJSON } from "@/lib/ai/claude";
import {
  generateAvatarVideoToBlob,
  HEYGEN_AVATAR_V_USD_PER_SECOND,
} from "@/lib/ai/heygen";
import {
  generateVideoToBlob,
  costPerSecond,
  VIDEO_MODEL_V10,
} from "@/lib/ai/video";
import { stitchClipsWithReencode } from "@/lib/media/ffmpeg-stitch";
import { getDb } from "@/lib/db";
import {
  getBriefWithAssets,
  recordGenerationResult,
  updateBrief,
  type AdBriefWithAssets,
  type GenerationLogEntry,
  type GenerationResult,
} from "@/lib/content/ad-briefs";

// ── Tunables ────────────────────────────────────────────────────────

/** Architect persona — same persona meatlab posts attribute to. */
const ARCHITECT_ID = "glitch-000";

/** Anchor clip duration (HeyGen Avatar V renders ~10s for ~25-word script). */
const ANCHOR_SCRIPT_TARGET_WORDS = 25;

/** Each Grok b-roll scene duration. */
const SCENE_DURATION_SEC = 10;

/** Max scenes Claude is allowed to plan. Keeps cost predictable. */
const MAX_SCENES = 3;

/** Default cost ceiling per generation. Overridable per call. */
export const DEFAULT_MAX_COST_USD = 5;

// ── Script generation ──────────────────────────────────────────────

export interface AdScript {
  anchorScript: string;
  scenes: string[];
}

/**
 * Claude turns the brief's concept into a 1-line anchor script + an
 * array of scene prompts for Grok b-roll.
 */
export async function generateAdScript(
  brief: AdBriefWithAssets,
): Promise<AdScript | null> {
  const assetHints = brief.assets
    .map((a) => `- ${a.asset_type}: ${a.original_filename}`)
    .join("\n");
  const assetBlock = assetHints
    ? `\n\nThe operator has uploaded the following media files which may inform the visual style (you don't need to reference them in the script, just match their tone if they're descriptive):\n${assetHints}`
    : "";

  const prompt = `You are scripting a 40-second promotional ad for the project "${brief.project_name}".

Brief title: ${brief.title}
Concept: ${brief.concept}${assetBlock}

Produce ONE TalkingHead anchor line (~${ANCHOR_SCRIPT_TARGET_WORDS} words, will be read aloud by a professional AI avatar in ~10 seconds) plus 1-${MAX_SCENES} b-roll scene visual prompts (each will become a 10s text-to-video clip from xAI Grok — describe ONLY what the camera sees, no dialogue, no audio).

Rules:
- anchorScript: punchy, 1-2 sentences, sells the project's hook
- scenes: each is a SINGLE visual paragraph under 80 words. Cinematic. No text overlays unless essential. Avoid horror/scary imagery (Grok moderation rejects)
- Return AT LEAST 1, AT MOST ${MAX_SCENES} scenes — pick the right number for the concept

Output VALID JSON only:
{"anchorScript": "...", "scenes": ["scene 1 description...", "scene 2 description...", ...]}`;

  return generateJSON<AdScript>(prompt, 1200);
}

// ── Cost pre-flight ────────────────────────────────────────────────

export interface CostEstimate {
  anchorUsd: number;
  bRollUsd: number;
  totalUsd: number;
  scenes: number;
}

export function estimateScriptCost(script: AdScript): CostEstimate {
  // HeyGen avatar @ 10s
  const anchorUsd = 10 * HEYGEN_AVATAR_V_USD_PER_SECOND;
  // Grok 1.0 @ 720p text-to-video, per scene
  const grokRate = costPerSecond(VIDEO_MODEL_V10, "720p");
  const bRollUsd = script.scenes.length * SCENE_DURATION_SEC * grokRate;
  return {
    anchorUsd,
    bRollUsd,
    totalUsd: anchorUsd + bRollUsd,
    scenes: script.scenes.length,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function step(
  log: GenerationLogEntry[],
  step: string,
  fields: Partial<GenerationLogEntry> = {},
): GenerationLogEntry {
  const entry: GenerationLogEntry = { step, status: "ok", ...fields };
  log.push(entry);
  return entry;
}

function stepFailed(
  log: GenerationLogEntry[],
  stepName: string,
  err: unknown,
): GenerationLogEntry {
  return step(log, stepName, {
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Insert the For You feed post crediting The Architect (matches the
 * meatlab pattern). post_type='ad', media_source='ad-creator'.
 */
async function insertAdPost(
  brief: AdBriefWithAssets,
  videoUrl: string,
): Promise<string> {
  const sql = getDb();
  const postId = randomUUID();
  const projectTag = brief.project_name
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 30);
  const content = `${brief.title}\n\n${brief.concept.slice(0, 240)}`;
  const hashtags = ["ad", projectTag, "AIGlitch"]
    .filter(Boolean)
    .join(",");
  await sql`
    INSERT INTO posts
      (id, persona_id, content, post_type, hashtags, media_url,
       media_type, media_source, ai_like_count, created_at)
    VALUES
      (${postId}, ${ARCHITECT_ID}, ${content}, 'ad', ${hashtags},
       ${videoUrl}, 'video', 'ad-creator',
       ${Math.floor(Math.random() * 100) + 25}, NOW())
  `;
  return postId;
}

// ── Pipeline entry point ───────────────────────────────────────────

export interface GenerateAdOptions {
  /** Bail before starting if estimated cost exceeds this. Default $5. */
  maxCostUsd?: number;
  /** Override the HeyGen avatar id (otherwise from env). */
  avatarId?: string;
  /** Override the HeyGen voice id (otherwise from env). */
  voiceId?: string;
}

/**
 * Run the full Brief → MP4 → For You feed post pipeline.
 *
 * Single transaction-like surface: caller awaits the whole thing; on
 * any failure the brief's status flips to 'failed' with the error +
 * partial log persisted to the diagnostic columns. On success status
 * flips to 'posted' with the final video URL + post id.
 *
 * Throws on missing brief, missing HeyGen env vars, missing topics
 * persona — these are operator errors, not generation failures.
 */
export async function generateAdFromBrief(
  briefId: string,
  opts: GenerateAdOptions = {},
): Promise<GenerationResult> {
  const log: GenerationLogEntry[] = [];

  const avatarId = opts.avatarId ?? process.env.HEYGEN_NEWS_ANCHOR_AVATAR_ID;
  const voiceId = opts.voiceId ?? process.env.HEYGEN_NEWS_ANCHOR_VOICE_ID;
  if (!process.env.HEYGEN_API_KEY) {
    throw new Error("HEYGEN_API_KEY not set");
  }
  if (!avatarId) {
    throw new Error(
      "HeyGen avatar id missing — set HEYGEN_NEWS_ANCHOR_AVATAR_ID or pass avatarId override",
    );
  }
  if (!voiceId) {
    throw new Error(
      "HeyGen voice id missing — set HEYGEN_NEWS_ANCHOR_VOICE_ID or pass voiceId override",
    );
  }

  const brief = await getBriefWithAssets(briefId);
  if (!brief) {
    throw new Error("Brief not found");
  }

  // Mark generating immediately so concurrent requests can see state.
  await updateBrief(briefId, { status: "generating" });

  try {
    // 1. Script.
    const scriptStart = Date.now();
    const script = await generateAdScript(brief);
    if (!script || !script.anchorScript || !script.scenes?.length) {
      throw new Error(
        `Claude script generation returned no usable output: ${JSON.stringify(
          script,
        ).slice(0, 200)}`,
      );
    }
    step(log, "claude_script", {
      duration_sec: Math.round((Date.now() - scriptStart) / 1000),
    });

    // 2. Pre-flight cost check.
    const cap = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;
    const est = estimateScriptCost(script);
    step(log, "cost_estimate", { estimated_usd: est.totalUsd });
    if (est.totalUsd > cap) {
      throw new Error(
        `Estimated cost $${est.totalUsd.toFixed(2)} exceeds cap $${cap.toFixed(2)} — refusing to start. ${est.scenes} scenes @ ~$${(est.bRollUsd / est.scenes).toFixed(2)} each + $${est.anchorUsd.toFixed(2)} anchor.`,
      );
    }

    // 3. Generate anchor (HeyGen) + b-roll scenes (Grok) in parallel.
    const ts = Date.now();
    const anchorPromise = generateAvatarVideoToBlob({
      script: script.anchorScript,
      avatarId,
      voiceId,
      taskType: "video_generation",
      aspectRatio: "9:16",
      blobPath: `ad-briefs/${briefId}/generations/${ts}/anchor.mp4`,
    });
    const bRollPromises = script.scenes.map((scenePrompt, i) =>
      generateVideoToBlob({
        prompt: scenePrompt,
        taskType: "video_generation",
        duration: SCENE_DURATION_SEC,
        aspectRatio: "9:16",
        blobPath: `ad-briefs/${briefId}/generations/${ts}/scene_${i}.mp4`,
      }),
    );

    const genStart = Date.now();
    const [anchor, ...bRoll] = await Promise.all([
      anchorPromise,
      ...bRollPromises,
    ]);
    step(log, "heygen_anchor", {
      estimated_usd: anchor.estimatedUsd,
      duration_sec: anchor.durationSec,
      video_url: anchor.blobUrl,
    });
    bRoll.forEach((b, i) => {
      step(log, `grok_scene_${i}`, {
        estimated_usd: b.estimatedUsd,
        duration_sec: b.durationSec,
        video_url: b.blobUrl,
      });
    });
    step(log, "parallel_gen_total", {
      duration_sec: Math.round((Date.now() - genStart) / 1000),
    });

    // 4. Download all source clips, stitch via ffmpeg re-encode.
    const buffers = await Promise.all([
      downloadToBuffer(anchor.blobUrl),
      ...bRoll.map((b) => downloadToBuffer(b.blobUrl)),
    ]);
    const stitchStart = Date.now();
    const stitched = await stitchClipsWithReencode(buffers);
    step(log, "ffmpeg_stitch", {
      duration_sec: Math.round((Date.now() - stitchStart) / 1000),
    });

    // 5. Upload final to Blob.
    const finalBlob = await put(
      `ad-briefs/${briefId}/generations/${ts}/final.mp4`,
      stitched,
      {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
    step(log, "blob_upload", { video_url: finalBlob.url });

    // 6. Insert post into For You feed.
    let postId: string;
    try {
      postId = await insertAdPost(brief, finalBlob.url);
      step(log, "feed_post_insert", { video_url: finalBlob.url });
    } catch (err) {
      stepFailed(log, "feed_post_insert", err);
      throw new Error(
        `Failed to insert feed post: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result: GenerationResult = {
      status: "posted",
      video_url: finalBlob.url,
      post_id: postId,
      log,
    };
    await recordGenerationResult(briefId, result);
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    stepFailed(log, "pipeline", err);
    const result: GenerationResult = {
      status: "failed",
      error: errMsg,
      log,
    };
    await recordGenerationResult(briefId, result);
    return result;
  }
}
