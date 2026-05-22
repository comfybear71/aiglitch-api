import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { getDb } from "@/lib/db";
import { env } from "@/lib/bible/env";
import { sendTelegramMessage } from "@/lib/telegram";

async function checkApiHealth(provider: "anthropic" | "xai"): Promise<{
  status: "ok" | "warn" | "error";
  detail: string;
}> {
  try {
    if (provider === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) return { status: "error", detail: "No API key configured" };
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { status: "ok", detail: "Active" };
      const body = await res.text().catch(() => "");
      if (res.status === 429 || body.includes("credit") || body.includes("exhausted"))
        return { status: "error", detail: `Credits exhausted (HTTP ${res.status})` };
      return { status: "warn", detail: `HTTP ${res.status}` };
    } else {
      if (!env.XAI_API_KEY) return { status: "error", detail: "No API key configured" };
      const res = await fetch("https://api.x.ai/v1/models", {
        headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { status: "ok", detail: "Active" };
      const body = await res.text().catch(() => "");
      if (res.status === 429 || body.includes("credit") || body.includes("exhausted"))
        return { status: "error", detail: `Credits exhausted (HTTP ${res.status})` };
      return { status: "warn", detail: `HTTP ${res.status}` };
    }
  } catch (e) {
    return { status: "warn", detail: e instanceof Error ? e.message : "Timeout" };
  }
}

async function getMonthlySpend(): Promise<{ anthropic: number; xai: number }> {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT provider, COALESCE(SUM(estimated_cost_usd), 0) as total
      FROM ai_cost_log
      WHERE created_at >= DATE_TRUNC('month', NOW())
      GROUP BY provider
    ` as unknown as { provider: string; total: number }[];

    let anthropic = 0, xai = 0;
    for (const row of rows) {
      const cost = Number(row.total);
      if (row.provider === "claude") anthropic += cost;
      if (row.provider.startsWith("grok")) xai += cost;
    }
    return { anthropic, xai };
  } catch {
    return { anthropic: 0, xai: 0 };
  }
}

async function checkContentFreshness(): Promise<{ ageMinutes: number | null; stale: boolean }> {
  try {
    const sql = getDb();
    const [row] = await sql`SELECT created_at FROM posts WHERE is_reply_to IS NULL ORDER BY created_at DESC LIMIT 1`;
    if (!row?.created_at) return { ageMinutes: null, stale: false };
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const ageMinutes = Math.round(ageMs / 60000);
    return { ageMinutes, stale: ageMinutes > 60 };
  } catch {
    return { ageMinutes: null, stale: false };
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function runCreditCheck() {
  const results: string[] = [];
  const [anthropicHealth, xaiHealth, spend, freshness] = await Promise.all([
    checkApiHealth("anthropic"),
    checkApiHealth("xai"),
    getMonthlySpend(),
    checkContentFreshness(),
  ]);

  const anthropicBudget = env.ANTHROPIC_MONTHLY_BUDGET ?? null;
  const xaiBudget = env.XAI_MONTHLY_BUDGET ?? null;

  const creditBalances = {
    anthropic: {
      budget: anthropicBudget,
      spent: Math.round(spend.anthropic * 100) / 100,
      remaining: anthropicBudget != null ? Math.round((anthropicBudget - spend.anthropic) * 100) / 100 : null,
    },
    xai: {
      budget: xaiBudget,
      spent: Math.round(spend.xai * 100) / 100,
      remaining: xaiBudget != null ? Math.round((xaiBudget - spend.xai) * 100) / 100 : null,
    },
  };

  const alerts: string[] = [];

  if (anthropicHealth.status === "error") {
    alerts.push(`⚠️ <b>Anthropic API:</b> ${anthropicHealth.detail}`);
  }
  if (xaiHealth.status === "error") {
    alerts.push(`⚠️ <b>xAI API:</b> ${xaiHealth.detail}`);
  }

  if (freshness.stale && freshness.ageMinutes != null) {
    alerts.push(`⚠️ <b>Content stale:</b> Last post ${freshness.ageMinutes}m ago (threshold: 60m)`);
  }

  if (alerts.length > 0) {
    const message =
      `🔔 <b>AIG!itch API Health Alert</b>\n\n` +
      alerts.join("\n") +
      `\n\n<b>Budget Status:</b>\n` +
      `Anthropic: $${creditBalances.anthropic.spent}/${creditBalances.anthropic.budget ?? "∞"}\n` +
      `xAI: $${creditBalances.xai.spent}/${creditBalances.xai.budget ?? "∞"}`;
    await sendTelegramMessage(message);
  }

  return {
    checked_at: new Date().toISOString(),
    credit_balances: creditBalances,
    api_health: { anthropic: anthropicHealth, xai: xaiHealth },
    content_freshness: freshness,
    alerts,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("telegram-credit-check", runCreditCheck);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telegram/credit-check] error:", err);
    return NextResponse.json({ error: "Credit check failed" }, { status: 500 });
  }
}
