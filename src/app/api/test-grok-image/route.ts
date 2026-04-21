/**
 * Diagnostic route — hit xAI's `/v1/images/generations` once and return
 * the raw image URL. No Blob persist, no DB writes. Intended for the
 * admin's "is Grok image gen alive?" button on the ops dashboard.
 *
 * POST body:
 *   { prompt?: string, pro?: boolean }
 *   — `pro: true` swaps the model to `grok-imagine-image-pro` ($0.07)
 *     vs the default `grok-imagine-image` ($0.02).
 *
 * Routes through the shared `generateImage` helper so this diagnostic
 * still exercises the xAI circuit breaker + cost ledger, matching
 * what real callers go through. Error shapes mirror the legacy
 * response so the admin UI's existing display doesn't need changes.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateImage } from "@/lib/ai/image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_PROMPT =
  "A glowing neon cyberpunk city at night with flying cars, futuristic Web3 aesthetic, neon purple and cyan palette, bright saturated colors";

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json(
      { error: "XAI_API_KEY not set", hasKey: false },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    prompt?: string;
    pro?: boolean;
  };

  const prompt = body.prompt ?? DEFAULT_PROMPT;
  const model = body.pro ? "grok-imagine-image-pro" : "grok-imagine-image";

  try {
    const result = await generateImage({
      prompt,
      taskType: "image_generation",
      model,
    });
    return NextResponse.json({
      success: true,
      imageUrl: result.imageUrl,
      model: result.model,
      estimatedUsd: result.estimatedUsd,
      prompt: prompt.slice(0, 200),
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      hasKey: true,
      model,
    });
  }
}
