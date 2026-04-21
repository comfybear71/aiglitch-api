/**
 * Grokify a sponsor placement — takes the sponsor's real logo/product images
 * and uses xAI's image-edit endpoint to weave them into a cinematic 9:16
 * scene. If no source images are provided, falls back to pure text-to-image
 * generation using the sponsor's `visual_prompt`.
 *
 *   POST { scenePrompt, visualPrompt, brandName, productName,
 *          logoUrl, productImageUrl, productImages, sceneIndex,
 *          isOutro, grokifyMode, channelId, sceneNumber }
 *     → generateImageToBlob (edits OR generations based on source images)
 *     → persist under `sponsors/grokified/{brand}-{channel}-{scene|outro}-{id}.png`
 *
 * Retry behaviour: if the multi-image edit fails, we retry once with just
 * the first source image. xAI's /images/edits is stricter about total
 * payload size with many source refs, and single-image often succeeds.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateImageToBlob } from "@/lib/ai/image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type GrokifyMode = "all" | "logo_only" | "images_only";

interface GrokifyBody {
  scenePrompt?: string;
  visualPrompt?: string;
  brandName?: string;
  productName?: string;
  logoUrl?: string;
  productImageUrl?: string;
  productImages?: string[];
  sceneIndex?: number;
  isOutro?: boolean;
  grokifyMode?: GrokifyMode;
  channelId?: string;
  sceneNumber?: number;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildEditPrompt(
  mode: GrokifyMode,
  brandName: string,
  productName: string,
  sceneContext: string,
): string {
  if (mode === "logo_only") {
    return `Place this ${brandName} logo prominently into a cinematic scene. The scene: ${sceneContext}. The ${brandName} logo MUST be clearly visible and recognizable — place it on a large billboard, a glowing neon sign on a wall, a poster, a banner, a screen, a building facade, or projected as a hologram. The logo should be LARGE, well-lit, and unmissable — like seeing the Coca-Cola logo on a Times Square billboard. NOT hidden or tiny. The logo is a key visual element of the scene. Cinematic 9:16 vertical format, shallow depth of field, professional color grading.`;
  }
  if (mode === "images_only") {
    return `Place this ${productName} product into a cinematic scene. The scene: ${sceneContext}. The product must appear naturally in the environment — on a table, held by a character, on a shelf, on a counter, as part of the set dressing. The product should be recognizable but feel like a natural part of the world — like product placement in a Hollywood movie. Cinematic 9:16 vertical format, shallow depth of field, professional color grading.`;
  }
  return `Place this ${brandName} branding and ${productName} product into a cinematic scene. The scene: ${sceneContext}. The ${brandName} logo must appear clearly on a billboard, wall poster, neon sign, or screen in the scene. The product itself should also appear naturally — on a table, shelf, or held by a character. Both the logo AND the product should be visible and recognizable. Cinematic 9:16 vertical format, shallow depth of field, professional color grading.`;
}

function buildTextFallbackPrompt(
  brandName: string,
  sceneContext: string,
  visualPrompt: string,
): string {
  const productDesc = visualPrompt.slice(0, 300);
  return `A cinematic 9:16 vertical film frame. The scene: ${sceneContext}. SUBLIMINAL PRODUCT PLACEMENT: ${productDesc}. The "${brandName}" logo appears on a billboard, wall poster, phone screen, or neon sign in the background. The SCENE is the focus — the product is just naturally part of the world. Cinematic lighting, shallow depth of field.`;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as GrokifyBody;
  const scenePrompt = body.scenePrompt ?? "";
  const visualPrompt = body.visualPrompt ?? "";
  const brandName = body.brandName ?? "Sponsor";
  const productName = body.productName ?? brandName;
  const logoUrl = body.logoUrl ?? "";
  const productImageUrl = body.productImageUrl ?? "";
  const productImages = body.productImages ?? [];
  const isOutro = body.isOutro ?? false;
  const grokifyMode: GrokifyMode = body.grokifyMode ?? "all";
  const channelId = body.channelId ?? "feed";
  const sceneNumber = body.sceneNumber ?? body.sceneIndex ?? 0;

  if (!scenePrompt) {
    return NextResponse.json({ error: "scenePrompt required" }, { status: 400 });
  }

  // Build the source-image set from the mode. Outro always forces the logo
  // in first-position regardless of mode — it's the closing brand beat.
  const allImages: string[] = [];
  if (grokifyMode === "logo_only" || grokifyMode === "all") {
    if (logoUrl) allImages.push(logoUrl);
  }
  if (grokifyMode === "images_only" || grokifyMode === "all") {
    if (productImageUrl && !allImages.includes(productImageUrl)) {
      allImages.push(productImageUrl);
    }
    for (const img of productImages) {
      if (img && !allImages.includes(img)) allImages.push(img);
    }
  }
  if (isOutro && logoUrl && !allImages.includes(logoUrl)) {
    allImages.unshift(logoUrl);
  }

  const sceneContext = scenePrompt.slice(0, 400);
  const imageRefs = allImages.slice(0, 5);
  const brandSlug = slugify(brandName);
  const channelSlug = slugify(channelId.replace("ch-", ""));
  const sceneLabel = isOutro ? "outro" : `scene${sceneNumber}`;

  function nextBlobPath(): string {
    return `sponsors/grokified/${brandSlug}-${channelSlug}-${sceneLabel}-${randomUUID().slice(0, 8)}.png`;
  }

  const editPrompt = buildEditPrompt(grokifyMode, brandName, productName, sceneContext);

  // No source images → pure text-to-image fallback.
  if (imageRefs.length === 0) {
    try {
      const { blobUrl } = await generateImageToBlob({
        prompt: buildTextFallbackPrompt(brandName, sceneContext, visualPrompt),
        taskType: "image_generation",
        model: "grok-imagine-image",
        aspectRatio: "9:16",
        blobPath: nextBlobPath(),
      });
      return NextResponse.json({
        grokifiedUrl: blobUrl,
        brandName,
        productName,
        mode: "text-to-image",
      });
    } catch (err) {
      return NextResponse.json({
        grokifiedUrl: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Source images → /images/edits. On multi-image failure, retry single-image.
  try {
    const { blobUrl } = await generateImageToBlob({
      prompt: editPrompt,
      taskType: "image_generation",
      model: "grok-imagine-image",
      aspectRatio: "9:16",
      sourceImageUrls: imageRefs,
      blobPath: nextBlobPath(),
    });
    return NextResponse.json({
      grokifiedUrl: blobUrl,
      brandName,
      productName,
      mode: "image-edit",
    });
  } catch (err) {
    if (imageRefs.length > 1) {
      try {
        const { blobUrl } = await generateImageToBlob({
          prompt: editPrompt,
          taskType: "image_generation",
          model: "grok-imagine-image",
          aspectRatio: "9:16",
          sourceImageUrls: [imageRefs[0]!],
          blobPath: nextBlobPath(),
        });
        return NextResponse.json({
          grokifiedUrl: blobUrl,
          brandName,
          productName,
          mode: "image-edit",
          retried: true,
        });
      } catch (retryErr) {
        return NextResponse.json({
          grokifiedUrl: null,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
    }
    return NextResponse.json({
      grokifiedUrl: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
