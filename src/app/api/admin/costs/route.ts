/**
 * GET /api/admin/costs          — 7-day cost window + all-time totals
 * GET /api/admin/costs?days=N   — custom history window
 *
 * Dashboard data surface:
 *   - lifetime        — all-time spend + call count
 *   - history         — per-day + provider + task_type rows (N days)
 *   - top_tasks       — top 5 most expensive (task_type, provider) pairs
 *   - provider_totals — per-provider lifetime breakdown
 *   - daily_totals    — per-day totals (for charts)
 *   - credit_balances — env-var budgets vs tracked spend
 *   - vercel          — monthly Vercel billing rollup (optional)
 *
 * Legacy exposed an in-memory `current_session` block coming from an
 * in-memory ledger that flushed periodically. Our architecture writes
 * to `ai_cost_log` on every call instead, so that field is omitted —
 * `lifetime` + `daily_totals` already cover it.
 *
 * Legacy's schema used `task` / `estimated_cost_usd`; ours uses
 * `task_type` / `estimated_usd`. All queries go through the read
 * helpers in `@/lib/ai/cost-ledger` which target our schema.
 *
 * Auth swapped from legacy `checkCronAuth` to `isAdminAuthenticated`
 * — it's a dashboard endpoint, not a cron.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  getLifetimeTotals,
  getCostHistory,
  getTopTasksByCost,
  getProviderTotals,
  getDailySpendTotals,
  type ProviderTotal,
} from "@/lib/ai/cost-ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const VERCEL_CACHE_REVALIDATE_SEC = 300;

function parseDays(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
  return Math.min(v, MAX_DAYS);
}

interface VercelUsageResult {
  available: boolean;
  usage?: {
    period: string;
    bandwidth_gb: number;
    builds: number;
    serverless_invocations: number;
    estimated_cost_usd: number;
  };
  error?: string;
}

/**
 * Fetch Vercel billing data via their REST API (FOCUS v1.3 JSONL). We
 * aggregate charges client-side by category keyword — Vercel's ServiceName
 * strings aren't stable enums, so we fuzzy-match. 5-minute edge cache.
 */
async function fetchVercelUsage(): Promise<VercelUsageResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { available: false };

  try {
    const teamId = process.env.VERCEL_TEAM_ID;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const params = new URLSearchParams();
    if (teamId) params.set("teamId", teamId);
    params.set("from", startOfMonth.toISOString().slice(0, 10));
    params.set("to", now.toISOString().slice(0, 10));

    const res = await fetch(`https://api.vercel.com/v1/billing/charges?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: VERCEL_CACHE_REVALIDATE_SEC },
    });

    if (!res.ok) {
      const text = await res.text();
      return { available: true, error: `Vercel API ${res.status}: ${text.slice(0, 200)}` };
    }

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);

    let totalCost = 0;
    let bandwidthBytes = 0;
    let buildCount = 0;
    let invocationCount = 0;

    for (const line of lines) {
      try {
        const charge = JSON.parse(line) as {
          BilledCost?: number | string;
          EffectiveCost?: number | string;
          ServiceName?: string;
          ServiceCategory?: string;
          ConsumedQuantity?: number | string;
        };
        totalCost += Number(charge.BilledCost ?? charge.EffectiveCost ?? 0);
        const svc = (charge.ServiceName ?? charge.ServiceCategory ?? "").toLowerCase();
        if (svc.includes("bandwidth") || svc.includes("data transfer")) {
          bandwidthBytes += Number(charge.ConsumedQuantity ?? 0);
        } else if (svc.includes("build")) {
          buildCount += Number(charge.ConsumedQuantity ?? 1);
        } else if (svc.includes("function") || svc.includes("serverless")) {
          invocationCount += Number(charge.ConsumedQuantity ?? 1);
        }
      } catch {
        // skip malformed lines
      }
    }

    return {
      available: true,
      usage: {
        period:                 `${startOfMonth.toISOString().slice(0, 10)} – ${now.toISOString().slice(0, 10)}`,
        bandwidth_gb:           Math.round((bandwidthBytes / (1024 * 1024 * 1024)) * 100) / 100,
        builds:                 buildCount,
        serverless_invocations: invocationCount,
        estimated_cost_usd:     Math.round(totalCost * 100) / 100,
      },
    };
  } catch (err) {
    return { available: true, error: err instanceof Error ? err.message : String(err) };
  }
}

interface CreditBalances {
  anthropic: { budget: number | null; spent: number; remaining: number | null };
  xai:       { budget: number | null; spent: number; remaining: number | null };
}

function computeCreditBalances(providerTotals: ProviderTotal[]): CreditBalances {
  const anthropicBudget = process.env.ANTHROPIC_MONTHLY_BUDGET
    ? Number(process.env.ANTHROPIC_MONTHLY_BUDGET)
    : null;
  const xaiBudget = process.env.XAI_MONTHLY_BUDGET
    ? Number(process.env.XAI_MONTHLY_BUDGET)
    : null;

  let anthropicSpent = 0;
  let xaiSpent = 0;
  for (const pt of providerTotals) {
    const cost = Number(pt.total_usd);
    if (pt.provider === "anthropic" || pt.provider === "claude") anthropicSpent += cost;
    if (pt.provider === "xai" || pt.provider.startsWith("grok")) xaiSpent += cost;
  }

  return {
    anthropic: {
      budget:    anthropicBudget,
      spent:     Math.round(anthropicSpent * 100) / 100,
      remaining: anthropicBudget != null
        ? Math.round((anthropicBudget - anthropicSpent) * 100) / 100
        : null,
    },
    xai: {
      budget:    xaiBudget,
      spent:     Math.round(xaiSpent * 100) / 100,
      remaining: xaiBudget != null
        ? Math.round((xaiBudget - xaiSpent) * 100) / 100
        : null,
    },
  };
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = parseDays(request.nextUrl.searchParams.get("days"));

  try {
    const [lifetime, history, topTasks, providerTotals, dailyTotals, vercel] = await Promise.all([
      getLifetimeTotals(),
      getCostHistory(days),
      getTopTasksByCost(days, 5),
      getProviderTotals(),
      getDailySpendTotals(days),
      fetchVercelUsage(),
    ]);

    return NextResponse.json({
      lifetime: {
        total_usd:   lifetime.totalUsd,
        total_calls: lifetime.totalCalls,
      },
      history,
      top_tasks:       topTasks,
      provider_totals: providerTotals,
      daily_totals:    dailyTotals,
      credit_balances: computeCreditBalances(providerTotals),
      vercel,
      days,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
