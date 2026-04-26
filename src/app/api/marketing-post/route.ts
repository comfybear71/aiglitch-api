/**
 * GET /api/marketing-post — Vercel cron (every 3h).
 *
 * Picks top AIG!itch content, adapts per platform, and posts to all
 * active accounts via runMarketingCycle. Cron-auth gated.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { runMarketingCycle } from "@/lib/marketing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("marketing-post", runMarketingCycle);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[marketing-post] cron error:", err);
    return NextResponse.json({ error: "Marketing cycle failed" }, { status: 500 });
  }
}
