/**
 * GET /api/feedback-loop  — Vercel cron every 6h (CRON_SECRET)
 * POST /api/feedback-loop — admin manual trigger
 *
 * Thin wrapper over `runFeedbackLoop()` — see src/lib/content/feedback-loop.ts
 * for the aggregation and prompt-hint update logic.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { runFeedbackLoop } from "@/lib/content/feedback-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("feedback-loop", runFeedbackLoop);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[feedback-loop] error:", err);
    return NextResponse.json({ error: "Feedback loop failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runFeedbackLoop();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[feedback-loop] error:", err);
    return NextResponse.json({ error: "Feedback loop failed" }, { status: 500 });
  }
}
