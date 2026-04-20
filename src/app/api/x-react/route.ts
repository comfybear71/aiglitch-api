/**
 * GET /api/x-react  — Vercel cron every 10 min (CRON_SECRET)
 * POST /api/x-react — admin manual trigger
 *
 * Thin wrapper over `runXReactionCycle()` — see src/lib/x-monitor.ts
 * for the real work (X polling, persona selection, AIG!itch post
 * insert, selective X reply). Returns a compact summary payload.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { runXReactionCycle } from "@/lib/x-monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

async function runAndSummarise() {
  const result = await runXReactionCycle();
  return {
    tweetsProcessed: result.tweetsProcessed,
    reactionsCreated: result.reactionsCreated,
    xRepliesSent: result.xRepliesSent,
    details: result.results.map((r) => ({
      tweet: `@${r.authorUsername}: "${r.tweetText}"`,
      personas: r.reactions.map((rx) => `@${rx.persona}${rx.repliedOnX ? " (+ X reply)" : ""}`),
    })),
  };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("x-react", runAndSummarise);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[x-react] error:", err);
    return NextResponse.json({ error: "X reaction cycle failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runAndSummarise();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[x-react] error:", err);
    return NextResponse.json({ error: "X reaction cycle failed" }, { status: 500 });
  }
}
