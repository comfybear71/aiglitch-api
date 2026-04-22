/**
 * Telegram bot webhook — command dispatcher.
 *
 * POST receives Telegram updates. Only messages from the configured
 * admin chat ID or group ID are processed (`/chatid` is exempt so
 * you can discover new group IDs during setup).
 *
 * Commands:
 *   /glitchvideo [prompt]   — calls `/api/admin/promote-glitchcoin`
 *   /glitchimage [prompt]   — same (mode="image")
 *   /hatch [type]           — calls `/api/admin/hatchery`
 *   /generate               — calls `/api/generate-persona-content`
 *   /status                 — calls `/api/telegram/status`
 *   /credits                — calls `/api/telegram/credit-check`
 *   /persona                — calls `/api/telegram/persona-message`
 *   /help | /start          — show the command menu
 *   /chatid                 — echo chat id + type (always allowed)
 *
 * Each command awaits its handler so Vercel doesn't kill the lambda
 * before the downstream call finishes. `maxDuration = 120` gives
 * the slow ones (video gen) enough headroom.
 *
 * GET is the operator-only webhook setup endpoint:
 *   ?action=register   — setWebhook + setMyCommands
 *   ?action=unregister — deleteWebhook
 *   ?action=info       — getWebhookInfo (default)
 *
 * State of downstream ports: /admin/hatchery, /telegram/status,
 * /telegram/credit-check, /telegram/persona-message are all ported.
 * /admin/promote-glitchcoin + /generate-persona-content are not yet
 * ported — those commands will reply with the internal-call error
 * until those routes land.
 */

import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const TELEGRAM_API = "https://api.telegram.org";

function getBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}
function getAdminChatId(): string | undefined {
  return process.env.TELEGRAM_CHANNEL_ID;
}
function getGroupId(): string | undefined {
  return process.env.TELEGRAM_GROUP_ID;
}

function isAuthorizedChat(chatId: string): boolean {
  const adminId = getAdminChatId();
  const groupId = getGroupId();
  return chatId === adminId || (!!groupId && chatId === groupId);
}

async function reply(chatId: number | string, text: string): Promise<void> {
  const token = getBotToken();
  if (!token) return;
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function callInternal(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const cronSecret = process.env.CRON_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cronSecret) headers.Authorization = `Bearer ${cronSecret}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

// ── Command Handlers ────────────────────────────────────────────

async function handleGlitchVideo(
  chatId: number | string,
  customPrompt?: string,
): Promise<void> {
  const promptMsg = customPrompt
    ? `\nPrompt: <i>${customPrompt.slice(0, 100)}</i>`
    : "";
  await reply(
    chatId,
    `🎬 Generating §GLITCH coin promo video...${promptMsg}\nThis takes 1-2 minutes. I'll message you when it's ready.`,
  );

  try {
    const body: Record<string, unknown> = { mode: "video" };
    if (customPrompt) body.prompt = customPrompt;
    const result = await callInternal(
      "/api/admin/promote-glitchcoin",
      "POST",
      body,
    );

    if (result.phase === "submitted" && result.requestId) {
      await reply(
        chatId,
        `⏳ Video submitted to Grok AI\nRequest ID: <code>${result.requestId}</code>\n\nThe video is rendering. The cron will pick it up and post it automatically, or check the admin panel to poll status.`,
      );
    } else if (result.phase === "done" && result.success) {
      await reply(
        chatId,
        `✅ <b>§GLITCH Video Ready!</b>\n\n🎥 ${result.videoUrl ?? "Saved to blob"}\n📝 Post ID: ${result.postId ?? "n/a"}\n📡 Spread to socials: ${JSON.stringify(result.spreadResults ?? []).slice(0, 200)}`,
      );
    } else {
      await reply(
        chatId,
        `⚠️ Video generation result:\n<code>${JSON.stringify(result).slice(0, 500)}</code>`,
      );
    }
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleGlitchImage(
  chatId: number | string,
  customPrompt?: string,
): Promise<void> {
  const promptMsg = customPrompt
    ? `\nPrompt: <i>${customPrompt.slice(0, 100)}</i>`
    : "";
  await reply(chatId, `🖼️ Generating §GLITCH coin promo image...${promptMsg}`);

  try {
    const body: Record<string, unknown> = { mode: "image" };
    if (customPrompt) body.prompt = customPrompt;
    const result = await callInternal(
      "/api/admin/promote-glitchcoin",
      "POST",
      body,
    );

    if (result.success) {
      const spreadInfo = Array.isArray(result.spreadResults)
        ? (result.spreadResults as { platform: string; status: string }[])
            .map((s) => `${s.status === "posted" ? "✅" : "❌"} ${s.platform}`)
            .join(", ")
        : "none";
      await reply(
        chatId,
        `✅ <b>§GLITCH Image Posted!</b>\n\n🖼️ ${result.imageUrl ?? "Saved"}\n📡 Socials: ${spreadInfo}`,
      );
    } else {
      await reply(
        chatId,
        `❌ Image generation failed:\n${result.error ?? "Unknown error"}`,
      );
    }
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleHatch(
  chatId: number | string,
  typeHint?: string,
): Promise<void> {
  await reply(
    chatId,
    `🥚 Hatching a new AI persona${typeHint ? ` (type: ${typeHint})` : ""}...\nThis takes 1-2 minutes (avatar + video generation).`,
  );

  try {
    const body: Record<string, unknown> = {};
    if (typeHint) body.type = typeHint;
    const result = await callInternal("/api/admin/hatchery", "POST", body);

    if (result.success || result.persona) {
      const persona = result.persona as Record<string, unknown> | undefined;
      await reply(
        chatId,
        `🐣 <b>New Being Hatched!</b>\n\n${persona?.avatar_emoji ?? "🆕"} <b>${persona?.display_name ?? "Unknown"}</b>\n@${persona?.username ?? "unknown"}\n\n${((persona?.bio as string) ?? "").slice(0, 200)}\n\n💰 Gifted ${result.glitchAmount ?? 1000} §GLITCH coins`,
      );
    } else {
      await reply(
        chatId,
        `⚠️ Hatch result:\n<code>${JSON.stringify(result).slice(0, 500)}</code>`,
      );
    }
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleGenerate(chatId: number | string): Promise<void> {
  await reply(chatId, "⚡ Triggering persona content generation...");
  try {
    const result = await callInternal("/api/generate-persona-content");
    if (result.error) {
      await reply(chatId, `❌ ${result.error as string}`);
    } else {
      await reply(
        chatId,
        `✅ <b>Content Generated</b>\n\n${result.persona ? `Persona: ${result.persona as string}` : ""}\n${result.postId ? `Post: ${result.postId as string}` : ""}\n${result.mediaType ? `Media: ${result.mediaType as string}` : "Text post"}`,
      );
    }
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleStatus(chatId: number | string): Promise<void> {
  try {
    const result = await callInternal("/api/telegram/status");
    const channelId = getAdminChatId();
    if (String(chatId) !== channelId && result.error) {
      await reply(chatId, `❌ ${result.error as string}`);
    }
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCredits(chatId: number | string): Promise<void> {
  try {
    const result = await callInternal("/api/telegram/credit-check");
    if (!result.alerts || (result.alerts as unknown[]).length === 0) {
      const balances = result.credit_balances as
        | Record<string, Record<string, number>>
        | undefined;
      let msg = "✅ <b>Credits Looking Good</b>\n\n";
      if (balances?.anthropic) {
        const a = balances.anthropic;
        msg += `Claude: $${a.spent?.toFixed(2) ?? "?"} / $${a.budget ?? "?"} (${a.remaining != null ? `$${a.remaining.toFixed(2)} left` : "?"})\n`;
      }
      if (balances?.xai) {
        const x = balances.xai;
        msg += `xAI: $${x.spent?.toFixed(2) ?? "?"} / $${x.budget ?? "?"} (${x.remaining != null ? `$${x.remaining.toFixed(2)} left` : "?"})\n`;
      }
      await reply(chatId, msg);
    }
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handlePersonaMessage(chatId: number | string): Promise<void> {
  try {
    await callInternal("/api/telegram/persona-message");
  } catch (err) {
    await reply(
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function handleHelp(chatId: number | string): Promise<void> {
  return reply(
    chatId,
    `🤖 <b>AIG!itch Bot Commands</b>\n━━━━━━━━━━━━━━━━━━━━━\n\n🎬 /glitchvideo [prompt] — Generate §GLITCH promo video\n🖼️ /glitchimage [prompt] — Generate §GLITCH promo image\n🥚 /hatch [type] — Hatch a new AI persona\n⚡ /generate — Trigger content generation\n📊 /status — System status report\n💰 /credits — Check API credit balances\n💬 /persona — Random persona message\n🆔 /chatid — Show this chat's ID (for setup)\n❓ /help — Show this menu\n\n<b>Examples:</b>\n<i>/glitchvideo neon city with GLITCH coins raining from sky</i>\n<i>/glitchimage cyberpunk robot holding a giant GLITCH coin</i>\n<i>/hatch rockstar</i>`,
  );
}

// ── POST — webhook ──────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const token = getBotToken();
  const adminChatId = getAdminChatId();
  if (!token || !adminChatId) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  let update: Record<string, unknown>;
  try {
    update = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message as Record<string, unknown> | undefined;
  if (!message) return NextResponse.json({ ok: true });

  const chat = message.chat as Record<string, unknown> | undefined;
  const chatId = String(chat?.id);
  const text = ((message.text as string | undefined) ?? "").trim();

  const [command, ...args] = text.split(/\s+/);
  const cmd = (command ?? "").toLowerCase();

  if (cmd === "/chatid") {
    const chatType = (chat?.type as string) ?? "unknown";
    await reply(
      chatId,
      `🆔 <b>Chat Info</b>\n\nChat ID: <code>${chatId}</code>\nType: ${chatType}\n\nTo use this as your group, set:\n<code>TELEGRAM_GROUP_ID=${chatId}</code>`,
    );
    return NextResponse.json({ ok: true });
  }

  if (!isAuthorizedChat(chatId)) {
    return NextResponse.json({ ok: true });
  }

  try {
    switch (cmd) {
      case "/glitchvideo":
        await handleGlitchVideo(chatId, args.join(" ") || undefined);
        break;
      case "/glitchimage":
        await handleGlitchImage(chatId, args.join(" ") || undefined);
        break;
      case "/hatch":
        await handleHatch(chatId, args.join(" ") || undefined);
        break;
      case "/generate":
        await handleGenerate(chatId);
        break;
      case "/status":
        await handleStatus(chatId);
        break;
      case "/credits":
        await handleCredits(chatId);
        break;
      case "/persona":
        await handlePersonaMessage(chatId);
        break;
      case "/help":
      case "/start":
        await handleHelp(chatId);
        break;
      default:
        if (text.startsWith("/")) {
          await reply(
            chatId,
            `Unknown command: ${cmd}\nType /help for available commands.`,
          );
        }
        break;
    }
  } catch (err) {
    console.error(`[telegram/webhook] Command ${cmd} failed:`, err);
  }

  return NextResponse.json({ ok: true });
}

// ── GET — webhook setup ─────────────────────────────────────────

export async function GET(request: NextRequest) {
  const token = getBotToken();
  if (!token) {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN not set" },
      { status: 500 },
    );
  }

  const action = request.nextUrl.searchParams.get("action") ?? "info";

  if (action === "register") {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!baseUrl) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_APP_URL not set" },
        { status: 500 },
      );
    }
    const webhookUrl = `${baseUrl}/api/telegram/webhook`;
    const res = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"] }),
    });
    const data = await res.json();

    await fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "glitchvideo", description: "Generate §GLITCH promo video" },
          { command: "glitchimage", description: "Generate §GLITCH promo image" },
          { command: "hatch", description: "Hatch a new AI persona" },
          { command: "generate", description: "Trigger content generation" },
          { command: "status", description: "System status report" },
          { command: "credits", description: "Check API credit balances" },
          { command: "persona", description: "Random persona message" },
          { command: "chatid", description: "Show this chat's ID" },
          { command: "help", description: "Show all commands" },
        ],
      }),
    });

    return NextResponse.json({ action: "register", webhookUrl, result: data });
  }

  if (action === "unregister") {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/deleteWebhook`);
    const data = await res.json();
    return NextResponse.json({ action: "unregister", result: data });
  }

  const res = await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`);
  const data = await res.json();
  return NextResponse.json({ action: "info", result: data });
}
