/**
 * Telegram Bot API client.
 *
 * Thin fetch wrapper — no external SDK. All calls go to
 * https://api.telegram.org/bot<token>/<method>.
 *
 * Admin channel helpers use TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID
 * from env. Per-persona bots use their own tokens from the DB.
 */

const TELEGRAM_API = "https://api.telegram.org";

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed (${res.status}): ${body}`);
  }
}

/**
 * Returns { token, chatId } for the global admin bot if both env vars
 * are set. Returns null when Telegram is not configured — callers
 * should skip the send rather than error out.
 */
export function getAdminChannel(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}
