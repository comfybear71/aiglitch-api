/**
 * MeatLab moderation alerts — ping admin when a submission lands pending.
 * Uses the same Telegram env vars as marketing spread / cron alerts.
 */

import {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramVideo,
} from "@/lib/telegram";

export interface MeatLabPendingNotifyInput {
  submissionId: string;
  title: string;
  description: string;
  mediaUrl: string;
  mediaType: string;
  aiTool?: string | null;
  creatorName: string;
  creatorUsername?: string | null;
  pendingCount?: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function adminMeatLabUrl(): string {
  const base = (process.env.ADMIN_APP_URL || "https://admin.aiglitch.app").replace(/\/$/, "");
  return `${base}/meatlab`;
}

function adminTelegramChatIds(): string[] {
  const ids: string[] = [];
  for (const raw of [
    process.env.TELEGRAM_CHAT_ID,
    process.env.TELEGRAM_CHANNEL_ID,
    process.env.TELEGRAM_GROUP_ID,
  ]) {
    if (!raw) continue;
    const id = String(raw);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function buildCaption(input: MeatLabPendingNotifyInput): string {
  const reviewUrl = adminMeatLabUrl();
  const titleLine = input.title.trim() || "(no title)";
  const creator = input.creatorUsername
    ? `@${input.creatorUsername.replace(/^@/, "")}`
    : input.creatorName;
  const pendingLine =
    input.pendingCount != null
      ? `\n📋 <b>${input.pendingCount}</b> waiting in queue`
      : "";

  let body = `🥩 <b>MEATLAB — REVIEW NEEDED</b>\n`;
  body += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  body += `👤 ${escapeHtml(creator)}\n`;
  body += `📌 ${escapeHtml(titleLine)}\n`;
  body += `🎬 ${escapeHtml(input.mediaType)}`;
  if (input.aiTool?.trim()) body += ` · ${escapeHtml(input.aiTool.trim())}`;
  body += pendingLine;
  body += `\n\n✅ <a href="${reviewUrl}">Open MeatLab Admin</a>`;
  return body;
}

/**
 * Push a Telegram alert with media preview (video/image) when configured.
 * Non-fatal — logs and returns false if Telegram env is missing.
 */
export async function notifyMeatLabPendingSubmission(
  input: MeatLabPendingNotifyInput,
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = adminTelegramChatIds();

  if (!token || chatIds.length === 0) {
    console.warn("[meatlab-notify] Telegram not configured (TELEGRAM_BOT_TOKEN + chat id)");
    return { ok: false, error: "Not configured" };
  }

  const caption = buildCaption(input);
  const primaryChat = chatIds[0]!;

  try {
    if (input.mediaType === "video") {
      const videoResult = await sendTelegramVideo(
        token,
        primaryChat,
        input.mediaUrl,
        caption,
      );
      if (!videoResult.ok) {
        console.warn(
          `[meatlab-notify] video preview failed: ${videoResult.error} — text fallback`,
        );
        for (const chatId of chatIds) {
          await sendTelegramMessage(caption, { chatId });
        }
        return { ok: true };
      }
    } else {
      const photoResult = await sendTelegramPhoto(
        token,
        primaryChat,
        input.mediaUrl,
        caption,
      );
      if (!photoResult.ok) {
        console.warn(
          `[meatlab-notify] photo preview failed: ${photoResult.error} — text fallback`,
        );
        for (const chatId of chatIds) {
          await sendTelegramMessage(caption, { chatId });
        }
        return { ok: true };
      }
    }

    for (const chatId of chatIds.slice(1)) {
      await sendTelegramMessage(caption, { chatId });
    }

    console.log(
      `[meatlab-notify] alerted Telegram for submission ${input.submissionId} (${input.mediaType})`,
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[meatlab-notify] failed:", msg);
    return { ok: false, error: msg };
  }
}
