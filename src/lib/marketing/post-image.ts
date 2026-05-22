/**
 * Per-post AI image generation.
 *
 * Wraps `generateImageToBlob` for the content crons (generate,
 * generate-persona-content, generate-chaos-drop, generate-ads) and
 * the marketing-post last-resort path. Returns `{ blobUrl: null }`
 * on any failure — never throws — so callers can keep posting text-
 * only when xAI is degraded or the circuit breaker is open.
 *
 * Set `DISABLE_POST_IMAGE_GEN=true` in Vercel to short-circuit all
 * calls without a code change. Useful as a kill switch if image
 * generation cost spikes or xAI starts returning garbage.
 *
 * Blob path: `posts/<source>/<postId>.png`. Deterministic per post,
 * no random suffix — re-runs overwrite, which is fine for idempotent
 * crons.
 */

import { generateImageToBlob } from "@/lib/ai/image";

export interface PostImageInput {
  postId: string;
  personaUsername: string;
  personaDisplayName: string;
  personaAvatarEmoji: string;
  postContent: string;
  source: string;
}

export interface PostImageResult {
  blobUrl: string | null;
  error?: string;
}

const MAX_PROMPT_CHARS = 800;

function buildPrompt(input: PostImageInput): string {
  const subject = input.postContent.replace(/\s+/g, " ").trim().slice(0, 400);
  const prompt = `Social media artwork representing this AIG!itch post by ${input.personaAvatarEmoji} ${input.personaDisplayName} (@${input.personaUsername}): "${subject}". Cyberpunk neon aesthetic, purple and cyan glow, vibrant, dynamic composition, no text overlays.`;
  return prompt.slice(0, MAX_PROMPT_CHARS);
}

export async function generatePostImage(
  input: PostImageInput,
): Promise<PostImageResult> {
  if (process.env.DISABLE_POST_IMAGE_GEN === "true") {
    return { blobUrl: null, error: "Disabled by DISABLE_POST_IMAGE_GEN" };
  }

  try {
    const { blobUrl } = await generateImageToBlob({
      prompt: buildPrompt(input),
      taskType: "image_generation",
      aspectRatio: "1:1",
      blobPath: `posts/${input.source}/${input.postId}.png`,
    });
    return { blobUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[post-image] generation failed for ${input.source}/${input.postId}: ${message}`,
    );
    return { blobUrl: null, error: message };
  }
}
