/**
 * POST /api/admin/sponsor-clip
 *
 * Generates a "sponsor thank-you" clip via Grok video. If product
 * images are supplied, the first image is used as the starting frame
 * (image-to-video) so the sponsor's actual product appears; otherwise
 * falls back to a generic cinematic sponsor-card (text-to-video).
 *
 * Returns `{ requestId, mode }` — the client polls the returned
 * requestId through the Grok video polling endpoint separately.
 *
 * Security note: legacy route had NO auth check at all. Added
 * isAdminAuthenticated here because each call spends real Grok video
 * credits ($0.25-$0.50 per clip).
 *
 * Body:
 *   { sponsorNames: string[],     // required, joined into the prompt
 *     sponsorImages?: string[] }  // optional; first one becomes the
 *                                 // Grok image_url seed if present
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const GROK_VIDEO_ENDPOINT = "https://api.x.ai/v1/videos/generations";
const VIDEO_MODEL = "grok-imagine-video";
const VIDEO_DURATION_SECONDS = 5;

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { sponsorNames?: string[]; sponsorImages?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sponsorNames = Array.isArray(body.sponsorNames) ? body.sponsorNames : [];
  const sponsorImages = Array.isArray(body.sponsorImages) ? body.sponsorImages : [];

  if (sponsorNames.length === 0) {
    return NextResponse.json({ error: "No sponsor names provided" }, { status: 400 });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const namesLine = sponsorNames.join(", ");
  const hasProductImage = sponsorImages.length > 0;

  const videoBody: Record<string, unknown> = {
    model: VIDEO_MODEL,
    duration: VIDEO_DURATION_SECONDS,
    aspect_ratio: "16:9",
    resolution: "720p",
  };

  if (hasProductImage) {
    // Use the first product image as the seed frame so Grok animates the
    // actual product instead of hallucinating a stand-in.
    videoBody.image_url = sponsorImages[0];
    videoBody.prompt =
      `A cinematic product showcase clip. The ${namesLine} product rotates slowly on a sleek dark surface ` +
      `with dramatic purple and cyan neon lighting. Premium product photography style with volumetric light rays. ` +
      `The product is the star — luxurious, desirable, beautifully lit. Subtle particle effects and lens flares. ` +
      `High-end commercial quality, like a Super Bowl ad. Camera slowly orbits the product. Dark background with ` +
      `professional studio lighting.`;
  } else {
    // No product image — use an abstract "sponsor card" prompt so Grok
    // isn't forced to render text (which it does poorly).
    videoBody.prompt =
      `A premium sponsor acknowledgment clip. Dark navy and purple gradient background with elegant neon purple and ` +
      `cyan light streaks. A golden spotlight slowly illuminates the center of the frame revealing a luxurious ` +
      `glowing emblem. Subtle particle effects float upward. The mood is grateful and prestigious — like an awards ` +
      `show sponsor moment. Cinematic lens flares, shallow depth of field, professional broadcast quality. Slow ` +
      `elegant camera push-in. Think high-end TV broadcast sponsor card with abstract beauty.`;
  }

  try {
    const createRes = await fetch(GROK_VIDEO_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(videoBody),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      return NextResponse.json(
        { error: `Grok failed: ${errText.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const createData = (await createRes.json()) as { request_id?: string; id?: string };
    const requestId = createData.request_id || createData.id;
    if (!requestId) {
      return NextResponse.json({ error: "Grok did not return a request id" }, { status: 502 });
    }

    return NextResponse.json({
      requestId,
      mode: hasProductImage ? "image-to-video" : "text-to-video",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
