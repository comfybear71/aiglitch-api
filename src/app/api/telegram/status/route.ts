/**
 * GET /api/telegram/status  — Vercel cron every 6 hours (CRON_SECRET)
 * POST /api/telegram/status — admin manual trigger
 *
 * Sends a system health summary to the admin Telegram channel:
 *   - Active persona count
 *   - Posts published in the last 24 h
 *   - Last 5 cron_runs (name + status + duration)
 *   - Any cron_runs with status='error' in the last 24 h
 *
 * Silent no-op when TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { sendMessage, getAdminChannel } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CronRun {
  cron_name: string;
  status: string;
  duration_ms: number | null;
  started_at: string;
}

async function runStatusReport() {
  const sql = getDb();

  const [personaRows, postRows, recentRuns, errorRuns] = await Promise.all([
    sql`SELECT COUNT(*)::int AS count FROM ai_personas WHERE is_active = TRUE` as unknown as Promise<{ count: number }[]>,
    sql`SELECT COUNT(*)::int AS count FROM posts WHERE created_at >= NOW() - INTERVAL '24 hours'` as unknown as Promise<{ count: number }[]>,
    sql`
      SELECT cron_name, status, duration_ms, started_at
      FROM cron_runs
      ORDER BY started_at DESC
      LIMIT 5
    ` as unknown as Promise<CronRun[]>,
    sql`
      SELECT cron_name, started_at
      FROM cron_runs
      WHERE status = 'error' AND started_at >= NOW() - INTERVAL '24 hours'
      ORDER BY started_at DESC
    ` as unknown as Promise<{ cron_name: string; started_at: string }[]>,
  ]);

  const activePersonas = personaRows[0]?.count ?? 0;
  const postsToday = postRows[0]?.count ?? 0;

  const channel = getAdminChannel();
  let sent = false;

  if (channel) {
    const cronLines = recentRuns.length > 0
      ? recentRuns.map((r) => {
          const icon = r.status === "ok" ? "✅" : r.status === "error" ? "❌" : "⏳";
          const ms = r.duration_ms != null ? ` (${r.duration_ms}ms)` : "";
          return `${icon} ${r.cron_name}${ms}`;
        }).join("\n")
      : "No runs yet";

    const errorSection = errorRuns.length > 0
      ? `\n\n⚠️ <b>${errorRuns.length} error(s) in last 24h:</b>\n` +
        errorRuns.map((r) => `• ${r.cron_name}`).join("\n")
      : "";

    const text =
      `📊 <b>AIG!itch Status Report</b>\n\n` +
      `👥 Active personas: <b>${activePersonas}</b>\n` +
      `📝 Posts today: <b>${postsToday}</b>\n\n` +
      `<b>Recent cron runs:</b>\n${cronLines}` +
      errorSection;

    await sendMessage(channel.token, channel.chatId, text);
    sent = true;
  }

  return {
    active_personas: activePersonas,
    posts_today: postsToday,
    recent_runs: recentRuns.length,
    errors_24h: errorRuns.length,
    sent,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("telegram-status", runStatusReport);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telegram/status] error:", err);
    return NextResponse.json({ error: "Status report failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runStatusReport();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telegram/status] error:", err);
    return NextResponse.json({ error: "Status report failed" }, { status: 500 });
  }
}
