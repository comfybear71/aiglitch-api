/**
 * POST /api/admin/ads/[id]/generate — kick off the Ad Creator
 * generation pipeline for a brief.
 *
 * Sync — caller awaits the whole brief-to-feed-post pipeline (Claude
 * script + HeyGen anchor + Grok b-roll + ffmpeg stitch + Blob + post).
 * Vercel maxDuration = 800s leaves comfortable headroom.
 *
 * On success: returns 200 with the GenerationResult (video URL +
 * post id + log). Brief's status flips to 'posted'.
 *
 * On failure: returns 200 with the GenerationResult carrying status
 * 'failed' + error + partial log. The brief's `last_error` /
 * `generation_log` columns are persisted so the admin can debug from
 * a GET /api/admin/ads/[id] without scraping Vercel logs.
 *
 * Body options (all optional):
 *   {
 *     maxCostUsd?: number,   // override default cap of $5
 *     avatarId?: string,     // override HEYGEN_NEWS_ANCHOR_AVATAR_ID
 *     voiceId?: string,      // override HEYGEN_NEWS_ANCHOR_VOICE_ID
 *   }
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateAdFromBrief } from "@/lib/content/ad-creator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Pipeline: Claude script (~5s) + HeyGen anchor (30-60s) +
// 1-3 Grok scenes in parallel (30-60s) + ffmpeg stitch (30-60s) +
// Blob upload + DB insert. Worst case ~3-4 min.
export const maxDuration = 800;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface GeneratePayload {
  maxCostUsd?: unknown;
  avatarId?: unknown;
  voiceId?: unknown;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Body is optional — empty JSON is fine.
  let body: GeneratePayload = {};
  try {
    body = (await request.json()) as GeneratePayload;
  } catch {
    body = {};
  }

  try {
    const result = await generateAdFromBrief(id, {
      maxCostUsd:
        typeof body.maxCostUsd === "number" ? body.maxCostUsd : undefined,
      avatarId: typeof body.avatarId === "string" ? body.avatarId : undefined,
      voiceId: typeof body.voiceId === "string" ? body.voiceId : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    // generateAdFromBrief catches all internal pipeline failures and
    // returns a `{status: 'failed', ...}` result. Reaching here means
    // a pre-flight error fired (missing brief / missing HeyGen env /
    // missing override) before generation even started — surface as
    // 4xx so the admin UI knows to fix config, not retry.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/ads/generate]", msg);
    if (msg === "Brief not found") {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (
      msg.includes("HEYGEN_API_KEY") ||
      msg.includes("HeyGen avatar id missing") ||
      msg.includes("HeyGen voice id missing")
    ) {
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
