/**
 * Telegram bot re-registration — points every active persona bot at the
 * new API domain's webhook and refreshes its slash-command menu.
 *
 * GET  — list active bots (persona_id, bot_username, display_name, emoji).
 *        NEVER returns `bot_token`. Used by the admin UI to build a
 *        client-side per-bot progress loop.
 * POST — two modes:
 *   • `{persona_id}` — re-register just that one bot. 404 when missing.
 *   • (no body)      — legacy bulk path: loops every active bot with a
 *     200ms spacing between `setWebhook` calls.
 *
 * For each bot: `setWebhook` to `{appUrl}/api/telegram/persona-chat/{id}`
 * with `allowed_updates = ["message", "message_reaction"]`, then call
 * `registerTelegramCommands(bot_token)` so the slash-command menu
 * always reflects the latest list.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { registerTelegramCommands } from "@/lib/telegram/commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const TELEGRAM_API = "https://api.telegram.org";

type BotRow = {
  persona_id: string;
  bot_token: string;
  bot_username: string | null;
};

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const bots = (await sql`
    SELECT b.persona_id, b.bot_username, p.display_name, p.avatar_emoji
    FROM persona_telegram_bots b
    LEFT JOIN ai_personas p ON p.id = b.persona_id
    WHERE b.is_active = TRUE
    ORDER BY b.persona_id
  `) as unknown as {
    persona_id: string;
    bot_username: string | null;
    display_name: string | null;
    avatar_emoji: string | null;
  }[];

  return NextResponse.json({ total: bots.length, bots });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL not set" },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
  };

  const sql = getDb();

  if (body.persona_id) {
    const rows = (await sql`
      SELECT persona_id, bot_token, bot_username
      FROM persona_telegram_bots
      WHERE persona_id = ${body.persona_id} AND is_active = TRUE
      LIMIT 1
    `) as unknown as BotRow[];

    const bot = rows[0];
    if (!bot) {
      return NextResponse.json(
        {
          success: false,
          persona_id: body.persona_id,
          status: "not_found",
          message: "No active Telegram bot found for this persona",
        },
        { status: 404 },
      );
    }

    const result = await reregisterOne(bot, appUrl);
    return NextResponse.json(result);
  }

  const bots = (await sql`
    SELECT persona_id, bot_token, bot_username
    FROM persona_telegram_bots
    WHERE is_active = TRUE
  `) as unknown as BotRow[];

  const details: Array<{
    persona_id: string;
    bot_username: string | null;
    status: "ok" | "failed";
    message?: string;
  }> = [];

  let updated = 0;
  const errors: string[] = [];

  for (const bot of bots) {
    const result = await reregisterOne(bot, appUrl);
    if (result.status === "ok") {
      updated++;
      details.push({
        persona_id: bot.persona_id,
        bot_username: bot.bot_username,
        status: "ok",
      });
    } else {
      const msg = result.message ?? "unknown";
      errors.push(`${bot.persona_id}: ${msg}`);
      details.push({
        persona_id: bot.persona_id,
        bot_username: bot.bot_username,
        status: "failed",
        message: msg,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return NextResponse.json({
    success: true,
    total: bots.length,
    updated,
    errors: errors.length,
    details,
  });
}

async function reregisterOne(
  bot: BotRow,
  appUrl: string,
): Promise<{
  success: boolean;
  persona_id: string;
  bot_username: string | null;
  status: "ok" | "failed";
  message?: string;
  commands_set?: boolean;
}> {
  const webhookUrl = `${appUrl}/api/telegram/persona-chat/${bot.persona_id}`;

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${bot.bot_token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "message_reaction"],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };

    if (data.ok) {
      const cmd = await registerTelegramCommands(bot.bot_token);
      return {
        success: true,
        persona_id: bot.persona_id,
        bot_username: bot.bot_username,
        status: "ok",
        commands_set: cmd.ok,
      };
    }
    return {
      success: false,
      persona_id: bot.persona_id,
      bot_username: bot.bot_username,
      status: "failed",
      message: data.description ?? "unknown",
    };
  } catch (err) {
    return {
      success: false,
      persona_id: bot.persona_id,
      bot_username: bot.bot_username,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
