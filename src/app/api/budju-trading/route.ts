/**
 * /api/budju-trading — user-facing BUDJU trading endpoint.
 *
 * Thin wrapper over `executeBudjuTradeBatch` from
 * `@/lib/trading/budju.ts` (v1.33.0 foundation). Approved per locked
 * decision #6 (sequential batch 2026-05-26). REAL on-chain BUDJU
 * trades — every cron fire signs+submits multiple transactions using
 * TREASURY_PRIVATE_KEY-derived persona wallet keys.
 *
 * Endpoints:
 *   GET  ?action=cron   — Vercel cron trigger (requires CRON_SECRET)
 *                          Runs 3-7 random trades per fire (matches legacy
 *                          "organic feel" sampling).
 *   POST                — admin manual trigger (requires admin cookie)
 *                          Body: { count?: number, max 20 }
 *
 * The `action=cron` shape note: the legacy vercel.json entry was
 * `/api/budju-trading` (no query string) which always hit the default
 * branch and returned 400 — meaning the BUDJU trading cron has been
 * effectively disabled since the strangler routed traffic through.
 * Fixed in this PR by updating the cron path to `?action=cron`.
 *
 * Differences from legacy:
 *   - cronStart/cronFinish (legacy lib/cron.ts) → cronHandler HOF
 *     (aiglitch-api's canonical pattern). Cron metrics still land in
 *     the cron_runs table.
 *   - Drops ensureDbReady per CLAUDE.md migration rule #4.
 */

import { type NextRequest, NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/admin-auth";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import {
  executeBudjuTradeBatch,
  getBudjuConfig,
} from "@/lib/trading/budju";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");

  if (action !== "cron") {
    return NextResponse.json({ error: "Use action=cron" }, { status: 400 });
  }

  const authErr = requireCronAuth(request);
  if (authErr) return authErr;

  const result = await cronHandler("budju-trading", async () => {
    // Check if BUDJU trading is enabled (admin can toggle via
    // setBudjuConfig). Matches legacy "paused" path.
    const config = await getBudjuConfig();
    if (config.enabled !== "true") {
      return {
        message: "BUDJU trading is paused",
        trades_executed: 0,
      };
    }

    // Random batch size 3-7 (matches legacy organic-feel sampling).
    const batchSize = 3 + Math.floor(Math.random() * 5);
    const batch = await executeBudjuTradeBatch(batchSize);

    return {
      trades_executed: batch.trades.length,
      budget_remaining: batch.budget_remaining,
      trades: batch.trades,
    };
  });

  return NextResponse.json({ success: true, ...result });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { count?: number };
  const count = Math.min(body.count ?? 5, 20);

  const result = await executeBudjuTradeBatch(count);

  return NextResponse.json({
    success: true,
    trades_executed: result.trades.length,
    budget_remaining: result.budget_remaining,
    is_enabled: result.is_enabled,
    trades: result.trades,
  });
}
