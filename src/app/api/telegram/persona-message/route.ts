/**
 * GET /api/telegram/persona-message  — Vercel cron every 3 hours (CRON_SECRET)
 * POST /api/telegram/persona-message — admin manual trigger
 *
 * For each active persona Telegram bot (persona_telegram_bots.is_active = true),
 * generates a short in-character message and sends it to the bot's configured
 * Telegram chat. Uses the persona's own bot_token (not the admin bot).
 *
 * Skips any bot with a missing token or chat_id. Skips any persona whose
 * AI generation returns an empty string. Errors on individual bots are
 * caught and counted — a single failure doesn't abort the whole run.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { sendMessage } from "@/lib/telegram";
import { generateTelegramMessage } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PersonaBot {
  persona_id: string;
  bot_token: string;
  telegram_chat_id: string;
  display_name: string;
  personality: string | null;
  bio: string | null;
}

async function runPersonaMessages() {
  const sql = getDb();

  const bots = (await sql`
    SELECT
      ptb.persona_id,
      ptb.bot_token,
      ptb.telegram_chat_id,
      p.display_name,
      p.personality,
      p.bio
    FROM persona_telegram_bots ptb
    JOIN ai_personas p ON p.id = ptb.persona_id
    WHERE ptb.is_active = TRUE
      AND ptb.bot_token IS NOT NULL
      AND ptb.telegram_chat_id IS NOT NULL
      AND p.is_active = TRUE
  `) as unknown as PersonaBot[];

  if (bots.length === 0) {
    return { sent: 0, skipped: 0, errors: 0, message: "No active persona bots" };
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const bot of bots) {
    try {
      const text = await generateTelegramMessage({
        persona: {
          personaId: bot.persona_id,
          displayName: bot.display_name,
          personality: bot.personality ?? undefined,
          bio: bot.bio ?? undefined,
        },
      });

      if (!text.trim()) {
        skipped += 1;
        continue;
      }

      await sendMessage(bot.bot_token, bot.telegram_chat_id, text);
      sent += 1;
    } catch (err) {
      console.error(`[telegram/persona-message] ${bot.display_name} failed:`, err);
      errors += 1;
    }
  }

  return { sent, skipped, errors };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("telegram-persona-message", runPersonaMessages);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telegram/persona-message] error:", err);
    return NextResponse.json({ error: "Persona message failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runPersonaMessages();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telegram/persona-message] error:", err);
    return NextResponse.json({ error: "Persona message failed" }, { status: 500 });
  }
}
