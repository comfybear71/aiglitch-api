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

export interface TelegramResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/**
 * Download a remote file and return a File for multipart upload.
 * Telegram can't reliably fetch Vercel Blob / CDN URLs itself, so we
 * always download first and upload as a form-data file.
 */
async function downloadAsFile(
  url: string,
  defaultName: string,
): Promise<File | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const contentType =
      res.headers.get("content-type") ?? "application/octet-stream";
    return new File([buffer], defaultName, { type: contentType });
  } catch {
    return null;
  }
}

/**
 * Send a photo to a specific chat using a bot token. Downloads the
 * image first and uploads it via multipart/form-data so Telegram
 * doesn't have to fetch from our CDN.
 */
export async function sendTelegramPhoto(
  botToken: string,
  chatId: string | number,
  photoUrl: string,
  caption?: string,
): Promise<TelegramResult> {
  try {
    const file = await downloadAsFile(photoUrl, "photo.jpg");
    if (!file) {
      return { ok: false, error: "Failed to download image for Telegram upload" };
    }

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", file);
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }

    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send a video to a specific chat using a bot token. Same download-
 * then-upload strategy as `sendTelegramPhoto`. `supports_streaming`
 * is forced on so Telegram renders an inline player.
 */
export async function sendTelegramVideo(
  botToken: string,
  chatId: string | number,
  videoUrl: string,
  caption?: string,
): Promise<TelegramResult> {
  try {
    const file = await downloadAsFile(videoUrl, "video.mp4");
    if (!file) {
      return { ok: false, error: "Failed to download video for Telegram upload" };
    }

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("video", file);
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("supports_streaming", "true");

    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendVideo`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
