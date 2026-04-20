/**
 * GET /api/marketing-metrics  — Vercel cron hourly (CRON_SECRET)
 * POST /api/marketing-metrics — admin manual trigger
 *
 * Thin wrapper over collectAllMetrics() — see src/lib/marketing/
 * metrics-collector.ts for the fetch/upsert logic.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { collectAllMetrics } from "@/lib/marketing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function run() {
  const { updated, failed, details } = await collectAllMetrics();
  return { updated, failed, details };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("marketing-metrics", run);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[marketing-metrics] error:", err);
    return NextResponse.json({ error: "Metrics collection failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await run();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[marketing-metrics] error:", err);
    return NextResponse.json({ error: "Metrics collection failed" }, { status: 500 });
  }
}
