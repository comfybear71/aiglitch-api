/**
 * GET /api/telegram/credit-check  — Vercel cron every 30 min (CRON_SECRET)
 * POST /api/telegram/credit-check — admin manual trigger
 *
 * Checks two credit indicators and sends a Telegram alert if either
 * trips a threshold:
 *
 *   1. AI spend total (ai_cost_log) — alert if cumulative >= $5 USD
 *   2. Sponsor low-balance — alert for each active sponsor with
 *      glitch_balance < LOW_BALANCE_THRESHOLD
 *
 * ai_cost_log query is wrapped in try/catch — the table may not exist
 * in all environments. Defaults to 0 on any error.
 *
 * Silently succeeds (alerted: false) when Telegram is not configured.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { sendMessage, getAdminChannel } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AI_SPEND_ALERT_USD = 5;
const LOW_BALANCE_THRESHOLD = 200;

async function runCreditCheck() {
  const sql = getDb();

  let totalUsd = 0;
  try {
    const spendRows = (await sql`
      SELECT COALESCE(SUM(estimated_usd), 0)::float AS total_usd
      FROM ai_cost_log
    `) as unknown as { total_usd: number }[];
    totalUsd = spendRows[0]?.total_usd ?? 0;
  } catch {
    // ai_cost_log may not exist yet — skip spend check
  }

  const lowSponsors = (await sql`
    SELECT company_name, glitch_balance
    FROM sponsors
    WHERE status = 'active' AND glitch_balance < ${LOW_BALANCE_THRESHOLD}
    ORDER BY glitch_balance ASC
  `) as unknown as { company_name: string; glitch_balance: number }[];

  const alerts: string[] = [];

  if (totalUsd >= AI_SPEND_ALERT_USD) {
    alerts.push(`⚠️ AI spend total: <b>$${totalUsd.toFixed(2)}</b> (threshold $${AI_SPEND_ALERT_USD})`);
  }

  for (const s of lowSponsors) {
    alerts.push(`💸 Low balance: <b>${s.company_name}</b> — §${s.glitch_balance} GLITCH remaining`);
  }

  let alerted = false;
  if (alerts.length > 0) {
    const channel = getAdminChannel();
    if (channel) {
      const text = `🔔 <b>AIG!itch Credit Check</b>\n\n${alerts.join("\n")}`;
      await sendMessage(channel.token, channel.chatId, text);
      alerted = true;
    }
  }

  return {
    total_usd: totalUsd,
    low_balance_count: lowSponsors.length,
    alerts: alerts.length,
    alerted,
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

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runCreditCheck();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telegram/credit-check] error:", err);
    return NextResponse.json({ error: "Credit check failed" }, { status: 500 });
  }
}
