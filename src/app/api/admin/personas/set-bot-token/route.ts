/**
 * Assign / revoke a Telegram bot token for a persona.
 *
 * POST — Body: `{ persona_id, bot_token? }`
 *
 *   Mode A — `bot_token` null / empty / omitted:
 *     UPDATE `persona_telegram_bots SET is_active = FALSE` for this
 *     persona. The row is preserved (+ the webhook is left
 *     registered, harmless) so re-enabling later is one UPDATE.
 *
 *   Mode B — `bot_token` present:
 *     1. Validate the token via Telegram `getMe` — if that fails
 *        we bail BEFORE touching the DB so we don't leave garbage.
 *     2. Register the webhook pointed at
 *        `{NEXT_PUBLIC_APP_URL}/api/telegram/persona-chat/{id}` with
 *        `allowed_updates=["message","message_reaction"]`. Webhook
 *        failures are non-fatal — surfaced in `webhook_error` so
 *        the admin can retry via the "Re-register Bots" button.
 *     3. DELETE + INSERT the `persona_telegram_bots` row.
 *     4. Call `registerTelegramCommands` to wire up the /help,
 *        /nft, /channel, /avatar, personality-mode menu. Non-fatal.
 *
 * Security: admin auth required. Validated with Telegram first so
 * garbage tokens never hit the DB. `bot_token` is never returned in
 * responses — the legacy GET leak risk is sidestepped by only
 * having this POST endpoint here.
 *
 * Unlike `/api/admin/telegram/re-register-bots`, this route is for
 * single-persona INITIAL assignment; the other is for bulk webhook
 * refresh of already-assigned bots.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { registerTelegramCommands } from "@/lib/telegram/commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const TELEGRAM_API = "https://api.telegram.org";

type Sql = ReturnType<typeof getDb>;

async function ensureTable(sql: Sql): Promise<void> {
  try {
    await sql`CREATE TABLE IF NOT EXISTS persona_telegram_bots (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      bot_username TEXT,
      telegram_chat_id TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  } catch {
    // best-effort: table may already exist with a stricter schema
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  await ensureTable(sql);

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
    bot_token?: string | null;
  };

  if (!body.persona_id) {
    return NextResponse.json({ error: "persona_id required" }, { status: 400 });
  }

  const personaRows = (await sql`
    SELECT id, username, display_name FROM ai_personas WHERE id = ${body.persona_id} LIMIT 1
  `) as unknown as {
    id: string;
    username: string;
    display_name: string;
  }[];
  const persona = personaRows[0];
  if (!persona) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  // Mode A — deactivate
  if (!body.bot_token || body.bot_token.trim() === "") {
    await sql`UPDATE persona_telegram_bots SET is_active = FALSE WHERE persona_id = ${body.persona_id}`;
    return NextResponse.json({
      success: true,
      persona_id: body.persona_id,
      action: "deactivated",
      message: `Deactivated Telegram bot for @${persona.username}`,
    });
  }

  // Mode B — set / replace
  const token = body.bot_token.trim();

  let botUsername: string | null = null;
  try {
    const meRes = await fetch(`${TELEGRAM_API}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const meData = (await meRes.json()) as {
      ok: boolean;
      description?: string;
      result?: { username?: string };
    };

    if (!meData.ok) {
      return NextResponse.json(
        { error: `Invalid bot token: ${meData.description ?? "getMe failed"}` },
        { status: 400 },
      );
    }

    botUsername = meData.result?.username ?? null;
    if (!botUsername) {
      return NextResponse.json(
        { error: "Bot token valid but getMe did not return a username" },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: `Telegram validation failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const webhookUrl = `${appUrl}/api/telegram/persona-chat/${body.persona_id}`;
  let webhookSet = false;
  let webhookError: string | null = null;

  try {
    const webhookRes = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "message_reaction"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const webhookData = (await webhookRes.json()) as {
      ok: boolean;
      description?: string;
    };
    webhookSet = !!webhookData.ok;
    if (!webhookData.ok) {
      webhookError = webhookData.description ?? "setWebhook failed";
    }
  } catch (err) {
    webhookError = err instanceof Error ? err.message : String(err);
  }

  await sql`DELETE FROM persona_telegram_bots WHERE persona_id = ${body.persona_id}`;
  await sql`
    INSERT INTO persona_telegram_bots (id, persona_id, bot_token, bot_username, is_active, created_at)
    VALUES (${randomUUID()}, ${body.persona_id}, ${token}, ${botUsername}, TRUE, NOW())
  `;

  const commandResult = await registerTelegramCommands(token);

  return NextResponse.json({
    success: true,
    persona_id: body.persona_id,
    action: "set",
    bot_username: botUsername,
    webhook_set: webhookSet,
    webhook_error: webhookError,
    commands_set: commandResult.ok,
    commands_error: commandResult.error ?? null,
    message: webhookSet
      ? `Bot @${botUsername} linked to ${persona.display_name}, webhook registered, and ${commandResult.ok ? "slash commands installed" : "slash commands pending"}.`
      : `Bot @${botUsername} saved but webhook failed: ${webhookError}. You can re-register via the Re-register All Bots button.`,
  });
}
