/**
 * Meatbag-facing Telegram bot setup for a hatched persona.
 *
 * Counterpart to `/api/admin/personas/set-bot-token` (which is
 * admin-auth'd + targets any persona). This route is session +
 * wallet-scoped: the caller must own a hatched persona (one
 * linked to their `phantom_wallet_address`) to wire up a bot.
 *
 * POST `{session_id, bot_token}`
 *   1. Verify the session has a wallet address.
 *   2. Resolve the wallet → hatched persona (`owner_wallet_address`
 *      match). 404 if none (meatbag hasn't hatched yet).
 *   3. Validate the token via Telegram `getMe`. Bail before DB
 *      writes on invalid.
 *   4. Register the webhook pointed at
 *      `{NEXT_PUBLIC_APP_URL}/api/telegram/persona-chat/{persona_id}`
 *      with `allowed_updates=["message","message_reaction"]`. A
 *      webhook failure is surfaced in `webhook_set` but the token
 *      is still saved so the meatbag can retry the webhook via the
 *      re-register button.
 *   5. DELETE any existing bot row for this persona, then INSERT
 *      the new one.
 *
 * DELETE `{session_id}`
 *   Same session → wallet → persona resolution, then best-efforts
 *   unregisters the webhook and removes the `persona_telegram_bots`
 *   row.
 *
 * `bot_token` is never returned in responses.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const TELEGRAM_API = "https://api.telegram.org";

type Sql = ReturnType<typeof getDb>;

async function resolvePersona(
  sql: Sql,
  sessionId: string,
): Promise<
  | { ok: true; persona: { id: string; display_name: string; username: string } }
  | { ok: false; status: number; error: string }
> {
  const userRows = (await sql`
    SELECT phantom_wallet_address FROM human_users WHERE session_id = ${sessionId}
  `) as unknown as { phantom_wallet_address: string | null }[];
  const wallet = userRows[0]?.phantom_wallet_address;
  if (!wallet) {
    return { ok: false, status: 403, error: "No wallet connected" };
  }

  const personaRows = (await sql`
    SELECT id, display_name, username FROM ai_personas
    WHERE owner_wallet_address = ${wallet}
    LIMIT 1
  `) as unknown as {
    id: string;
    display_name: string;
    username: string;
  }[];
  const persona = personaRows[0];
  if (!persona) {
    return {
      ok: false,
      status: 404,
      error: "No AI persona found. Hatch one first!",
    };
  }
  return { ok: true, persona };
}

export async function POST(request: NextRequest) {
  let body: { session_id?: string; bot_token?: string };
  try {
    body = (await request.json()) as { session_id?: string; bot_token?: string };
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!body.session_id || !body.bot_token?.trim()) {
    return NextResponse.json(
      { error: "Missing session_id or bot_token" },
      { status: 400 },
    );
  }

  const sql = getDb();
  const resolved = await resolvePersona(sql, body.session_id);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const persona = resolved.persona;
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
        {
          error:
            "Invalid bot token. Make sure you copied the full token from @BotFather.",
          detail: meData.description,
        },
        { status: 400 },
      );
    }
    botUsername = meData.result?.username ?? null;
  } catch {
    return NextResponse.json(
      {
        error:
          "Failed to validate bot token. Check your internet connection and try again.",
      },
      { status: 500 },
    );
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    new URL(request.url).origin;
  const webhookUrl = `${appUrl}/api/telegram/persona-chat/${persona.id}`;

  let webhookSet = false;
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
    const webhookData = (await webhookRes.json()) as { ok: boolean };
    webhookSet = !!webhookData.ok;
  } catch {
    // Non-fatal — save the token anyway so the meatbag can retry.
  }

  await sql`DELETE FROM persona_telegram_bots WHERE persona_id = ${persona.id}`;
  await sql`
    INSERT INTO persona_telegram_bots (id, persona_id, bot_token, bot_username, is_active)
    VALUES (${randomUUID()}, ${persona.id}, ${token}, ${botUsername}, TRUE)
  `;

  return NextResponse.json({
    success: true,
    bot_username: botUsername,
    webhook_set: webhookSet,
    message: botUsername
      ? `Bot @${botUsername} is now connected to ${persona.display_name}! Send a message to start chatting.`
      : `Bot connected to ${persona.display_name}!`,
  });
}

export async function DELETE(request: NextRequest) {
  let body: { session_id?: string };
  try {
    body = (await request.json()) as { session_id?: string };
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!body.session_id) {
    return NextResponse.json(
      { error: "Missing session_id" },
      { status: 400 },
    );
  }

  const sql = getDb();
  const resolved = await resolvePersona(sql, body.session_id);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const persona = resolved.persona;

  const botRows = (await sql`
    SELECT bot_token FROM persona_telegram_bots
    WHERE persona_id = ${persona.id} AND is_active = TRUE
  `) as unknown as { bot_token: string }[];
  const bot = botRows[0];

  if (bot) {
    try {
      await fetch(`${TELEGRAM_API}/bot${bot.bot_token}/deleteWebhook`, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // ignore cleanup failures
    }
  }

  await sql`DELETE FROM persona_telegram_bots WHERE persona_id = ${persona.id}`;

  return NextResponse.json({
    success: true,
    message: "Telegram bot disconnected.",
  });
}
