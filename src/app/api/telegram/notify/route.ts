/**
 * Admin Telegram notification endpoint.
 *
 * POST — Sends an alert to the configured admin Telegram channel.
 * Gated on cron-auth (`requireCronAuth`) so internal systems + the
 * Vercel cron can both hit it with `Authorization: Bearer
 * $CRON_SECRET`. Body:
 *   `{ title?: string, message: string,
 *     severity?: "info" | "warning" | "critical" }`
 *
 * When `title` is set the message is formatted as `⚠️ <b>title</b>
 * \n\nmessage` with the severity emoji prefix (ℹ️ / ⚠️ / 🚨). When
 * `title` is omitted the `message` is sent verbatim.
 *
 * Silent no-op when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHANNEL_ID`
 * aren't configured — returns `{ok:false, reason:"telegram-not-configured"}`
 * instead of erroring so the caller (often a cron) doesn't blow up.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { getAdminChannel, sendMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Severity = "info" | "warning" | "critical";

const SEVERITY_EMOJI: Record<Severity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

function formatAlert(
  title: string,
  details: string,
  severity: Severity,
): string {
  return `${SEVERITY_EMOJI[severity]} <b>${title}</b>\n\n${details}`;
}

export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
      message?: string;
      severity?: Severity;
    };
    const severity: Severity = body.severity ?? "warning";

    if (!body.message) {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 },
      );
    }

    const channel = getAdminChannel();
    if (!channel) {
      return NextResponse.json({
        ok: false,
        reason: "telegram-not-configured",
      });
    }

    const text = body.title
      ? formatAlert(body.title, body.message, severity)
      : body.message;

    await sendMessage(channel.token, channel.chatId, text);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
