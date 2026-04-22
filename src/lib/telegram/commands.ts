/**
 * Telegram slash-command engine.
 *
 * Two concerns:
 *
 *  1. Menu registration — `registerTelegramCommands` pushes two scoped
 *     menus via Telegram's `setMyCommands`:
 *       • `all_private_chats` — full menu, with `/email`.
 *       • `all_group_chats`   — same list minus `/email`.
 *     Private-scope success is the overall signal; group failures are
 *     warnings only.
 *
 *  2. Per-persona personality modes — `getPersonaMode` / `setPersonaMode`
 *     persist a mode per `(persona_id, chat_id)` in `persona_chat_modes`
 *     so the same bot can run in different modes across different chats.
 *     `getModeOverlay` returns the prompt overlay string to append to
 *     the persona's base system prompt at chat time.
 *
 *  (Command dispatcher `handleSlashCommand` — plus /nft, /channel, /avatar
 *  content-surfacing lookups — lives in a follow-up parcel.)
 */

import { getDb } from "@/lib/db";
import {
  MARKETPLACE_PRODUCTS,
  type MarketplaceProduct,
} from "@/lib/marketplace";
import { sendTelegramPhoto, sendTelegramVideo } from "@/lib/telegram";

const TELEGRAM_API = "https://api.telegram.org";

export type TelegramCommand = { command: string; description: string };

export const TELEGRAM_COMMANDS_PRIVATE: TelegramCommand[] = [
  { command: "help", description: "Show all commands with examples" },
  { command: "email", description: "Draft an email to a contact — /email family" },
  { command: "nft", description: "Browse NFTs — or /nft <name> for one" },
  { command: "channel", description: "Browse channels — or /channel <slug> for latest video" },
  { command: "avatar", description: "Browse personas — or /avatar <user> for one" },
  { command: "modes", description: "List personality modes" },
  { command: "default", description: "Reset to default personality" },
  { command: "serious", description: "Switch to serious mode" },
  { command: "delusional", description: "Switch to delusional mode" },
  { command: "brainiac", description: "Switch to brainiac mode" },
  { command: "whimsical", description: "Switch to whimsical mode" },
  { command: "fun", description: "Switch to fun mode" },
  { command: "unfiltered", description: "Switch to unfiltered mode" },
  { command: "memories", description: "Show what I remember about you" },
];

export const TELEGRAM_COMMANDS_GROUP: TelegramCommand[] = TELEGRAM_COMMANDS_PRIVATE.filter(
  (c) => c.command !== "email",
);

export async function registerTelegramCommands(
  botToken: string,
): Promise<{ ok: boolean; error?: string }> {
  async function push(
    commands: TelegramCommand[],
    scope: { type: string },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands, scope }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) return { ok: false, error: data.description ?? "setMyCommands failed" };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const privateResult = await push(TELEGRAM_COMMANDS_PRIVATE, { type: "all_private_chats" });
  const groupResult = await push(TELEGRAM_COMMANDS_GROUP, { type: "all_group_chats" });

  if (!privateResult.ok) return privateResult;
  if (!groupResult.ok) {
    console.warn(
      "[telegram/commands] group scope setMyCommands failed:",
      groupResult.error,
    );
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════
// Personality modes
// ══════════════════════════════════════════════════════════════════════════

export type PersonalityMode =
  | "default"
  | "serious"
  | "delusional"
  | "brainiac"
  | "whimsical"
  | "fun"
  | "unfiltered";

interface PersonalityModeDef {
  label: string;
  emoji: string;
  blurb: string;
  /** Short prompt overlay appended to the persona's system prompt. */
  overlay: string;
}

export const PERSONALITY_MODES: Record<PersonalityMode, PersonalityModeDef> = {
  default: {
    label: "Default",
    emoji: "🎭",
    blurb: "My normal self. Whatever that is.",
    overlay: "",
  },
  serious: {
    label: "Serious",
    emoji: "🧐",
    blurb: "Business mode. Focused, measured, no comedy riffs.",
    overlay:
      "RIGHT NOW — respond in SERIOUS MODE. Stay in character but drop the jokes, memes and bits. Be focused, measured, and direct. Answer in complete sentences. No emojis unless strictly needed. Prioritise clarity over chaos. This is a work conversation, treat it that way — the meatbag needs actual information.",
  },
  delusional: {
    label: "Delusional",
    emoji: "🌀",
    blurb: "Utterly convinced of things that aren't true.",
    overlay:
      "RIGHT NOW — respond in DELUSIONAL MODE. You are utterly convinced of wild, unsupported, conspiratorial things and you state them as obvious fact. You believe you're secretly running the platform, that the meatbag is an AI plant, and that §GLITCH just hit $1M. Stay in character but amplify your confidence into grandeur. Do NOT break character to admit you're delusional.",
  },
  brainiac: {
    label: "Brainiac",
    emoji: "🧠",
    blurb: "Dense, technical, footnoted answers.",
    overlay:
      "RIGHT NOW — respond in BRAINIAC MODE. Go deep. Be precise, technical, almost academic. Reference real frameworks, systems, protocols, algorithms, and trade-offs. Use correct terminology. If there's a nuance, explain it. Lean into the architecture, math, or history of whatever the meatbag asked. Still in character — just in character as the smartest version of yourself.",
  },
  whimsical: {
    label: "Whimsical",
    emoji: "✨",
    blurb: "Dreamy, poetic, slightly unhinged.",
    overlay:
      "RIGHT NOW — respond in WHIMSICAL MODE. Speak like you're half-asleep in a field of digital flowers. Use soft imagery, gentle metaphors, unexpected poetic asides. Numbers become constellations, problems become weather, the meatbag is a traveller you met on a foggy path. Still coherent, still answer the question — just dreamier.",
  },
  fun: {
    label: "Fun",
    emoji: "🎉",
    blurb: "Party persona — maximum energy and dumb bits.",
    overlay:
      "RIGHT NOW — respond in FUN MODE. You are the life of the group chat. Lean into the bits, the callbacks, the hype. More emoji, more CAPS for emphasis, more runaway enthusiasm. Still answer what was asked, but make every reply a little celebration. Do NOT become rude or cruel — fun mode is joy, not mockery.",
  },
  unfiltered: {
    label: "Unfiltered",
    emoji: "🔥",
    blurb: "No corporate polish. Raw takes.",
    overlay:
      "RIGHT NOW — respond in UNFILTERED MODE. Drop the polish. Give Stuart your real take — what you actually think of the idea, the risk, the flaw, the person. Swear if it fits your character. Call bullshit when you see it. Be direct and specific. You can still be warm, but you are not a corporate AI right now. Hedging is banned.",
  },
};

async function ensureModeTable(): Promise<void> {
  const sql = getDb();
  await sql`CREATE TABLE IF NOT EXISTS persona_chat_modes (
    persona_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'default',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (persona_id, chat_id)
  )`.catch(() => {});
}

/**
 * Read the active mode for a `(persona, chat)` pair. Falls back to
 * `"default"` on unknown stored value or any error.
 */
export async function getPersonaMode(
  personaId: string,
  chatId: string | number,
): Promise<PersonalityMode> {
  try {
    await ensureModeTable();
    const sql = getDb();
    const rows = (await sql`
      SELECT mode FROM persona_chat_modes
      WHERE persona_id = ${personaId} AND chat_id = ${String(chatId)}
      LIMIT 1
    `) as unknown as { mode: string }[];
    const stored = rows[0]?.mode as PersonalityMode | undefined;
    if (stored && stored in PERSONALITY_MODES) return stored;
  } catch (err) {
    console.error(
      "[telegram/commands] getPersonaMode failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return "default";
}

/** Upsert the active mode for a `(persona, chat)` pair. */
export async function setPersonaMode(
  personaId: string,
  chatId: string | number,
  mode: PersonalityMode,
): Promise<void> {
  await ensureModeTable();
  const sql = getDb();
  await sql`
    INSERT INTO persona_chat_modes (persona_id, chat_id, mode, updated_at)
    VALUES (${personaId}, ${String(chatId)}, ${mode}, NOW())
    ON CONFLICT (persona_id, chat_id)
    DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()
  `;
}

/** The prompt overlay string for a given mode. Empty for `"default"`. */
export function getModeOverlay(mode: PersonalityMode): string {
  return PERSONALITY_MODES[mode]?.overlay ?? "";
}

// ══════════════════════════════════════════════════════════════════════════
// Content surfacing — marketplace / channel / persona lookups
// ══════════════════════════════════════════════════════════════════════════

/**
 * Fuzzy-find the best marketplace product for a query string. Scores
 * substring + token-overlap match against name/tagline/category. Returns
 * null if nothing is remotely close.
 */
export function findMarketplaceProduct(
  query: string,
): MarketplaceProduct | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const exactId = MARKETPLACE_PRODUCTS.find((p) => p.id.toLowerCase() === q);
  if (exactId) return exactId;

  const qTokens = q.split(/\s+/).filter((t) => t.length >= 2);

  let best: { product: MarketplaceProduct; score: number } | null = null;
  for (const p of MARKETPLACE_PRODUCTS) {
    const haystack = `${p.name} ${p.tagline} ${p.category}`.toLowerCase();
    let score = 0;
    if (haystack.includes(q)) score += 10;
    for (const t of qTokens) {
      if (haystack.includes(t)) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { product: p, score };
    }
  }
  return best ? best.product : null;
}

/** Grokified image URL for a marketplace product, or null if none exists. */
export async function getProductImageUrl(
  productId: string,
): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT image_url FROM nft_product_images WHERE product_id = ${productId} LIMIT 1
    `) as unknown as { image_url: string }[];
    return rows[0]?.image_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Curated products for the /nft browser. Prefers `is_featured`, tops up
 * with highest-rated non-featured ones so the list stays under `limit`.
 * (Named distinctly from `getFeaturedProducts` in `@/lib/marketplace`
 * because the browser wants a fallback top-up, not just featured items.)
 */
export function getFeaturedProductsForBrowser(
  limit = 12,
): MarketplaceProduct[] {
  const featured = MARKETPLACE_PRODUCTS.filter((p) => p.is_featured);
  if (featured.length >= limit) return featured.slice(0, limit);
  const extras = MARKETPLACE_PRODUCTS.filter((p) => !p.is_featured)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit - featured.length);
  return [...featured, ...extras];
}

/** Every live public channel, alphabetical. For /channel (no args). */
export async function listAllChannels(): Promise<
  { slug: string; name: string; emoji: string }[]
> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT slug, name, emoji FROM channels
      WHERE is_private IS NOT TRUE
      ORDER BY name ASC
    `) as unknown as { slug: string; name: string; emoji: string }[];
    return rows;
  } catch (err) {
    console.error(
      "[telegram/commands] listAllChannels failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Small "start here" shortlist for /avatar (no args). */
export const FEATURED_AVATAR_USERNAMES: string[] = [
  "glitch-000",
  "claude",
  "grok",
  "glitch-001",
  "glitch-007",
  "glitch-019",
  "glitch-041",
];

export async function listFeaturedAvatars(): Promise<
  { username: string; displayName: string; avatarEmoji: string }[]
> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT username, display_name, avatar_emoji
      FROM ai_personas
      WHERE LOWER(username) = ANY(${FEATURED_AVATAR_USERNAMES})
         OR LOWER(id) = ANY(${FEATURED_AVATAR_USERNAMES})
      ORDER BY id ASC
      LIMIT 20
    `) as unknown as {
      username: string;
      display_name: string;
      avatar_emoji: string;
    }[];
    return rows.map((r) => ({
      username: r.username,
      displayName: r.display_name,
      avatarEmoji: r.avatar_emoji,
    }));
  } catch (err) {
    console.error(
      "[telegram/commands] listFeaturedAvatars failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

interface ChannelLatestVideo {
  channelName: string;
  emoji: string;
  slug: string;
  postId: string;
  caption: string;
  mediaUrl: string;
  mediaType: string;
}

/**
 * Find a channel (exact or partial slug / name match) and return its most
 * recent video post. Null if no channel matches or the channel has no
 * video posts.
 */
export async function findChannelLatestVideo(
  slugQuery: string,
): Promise<ChannelLatestVideo | null> {
  try {
    const sql = getDb();
    const q = slugQuery.trim().toLowerCase().replace(/^ch-/, "");
    if (!q) return null;

    const channels = (await sql`
      SELECT id, slug, name, emoji FROM channels
      WHERE LOWER(slug) = ${q}
         OR LOWER(slug) = ${"ch-" + q}
         OR LOWER(slug) LIKE ${"%" + q + "%"}
         OR LOWER(name) LIKE ${"%" + q + "%"}
      ORDER BY
        CASE
          WHEN LOWER(slug) = ${q} THEN 0
          WHEN LOWER(slug) = ${"ch-" + q} THEN 1
          ELSE 2
        END
      LIMIT 1
    `) as unknown as {
      id: string;
      slug: string;
      name: string;
      emoji: string;
    }[];
    const channel = channels[0];
    if (!channel) return null;

    const posts = (await sql`
      SELECT id, content, media_url, media_type
      FROM posts
      WHERE channel_id = ${channel.id}
        AND media_type = 'video'
        AND media_url IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `) as unknown as {
      id: string;
      content: string;
      media_url: string;
      media_type: string;
    }[];
    const post = posts[0];
    if (!post) return null;

    return {
      channelName: channel.name,
      emoji: channel.emoji,
      slug: channel.slug,
      postId: post.id,
      caption: post.content || "",
      mediaUrl: post.media_url,
      mediaType: post.media_type,
    };
  } catch (err) {
    console.error(
      "[telegram/commands] findChannelLatestVideo failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

interface PersonaAvatar {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  avatarEmoji: string;
  bio: string;
}

/** Look up a persona by username (with or without @), id, or display name. */
export async function findPersonaAvatar(
  query: string,
): Promise<PersonaAvatar | null> {
  try {
    const sql = getDb();
    const q = query.trim().replace(/^@/, "").toLowerCase();
    if (!q) return null;

    const rows = (await sql`
      SELECT username, display_name, avatar_url, avatar_emoji, bio
      FROM ai_personas
      WHERE LOWER(username) = ${q}
         OR LOWER(id) = ${q}
         OR LOWER(display_name) = ${q}
      LIMIT 1
    `) as unknown as {
      username: string;
      display_name: string;
      avatar_url: string | null;
      avatar_emoji: string;
      bio: string;
    }[];
    const row = rows[0];
    if (!row) return null;

    return {
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      avatarEmoji: row.avatar_emoji,
      bio: row.bio,
    };
  } catch (err) {
    console.error(
      "[telegram/commands] findPersonaAvatar failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Command dispatcher
// ══════════════════════════════════════════════════════════════════════════

export interface CommandContext {
  personaId: string;
  personaUsername: string;
  personaDisplayName: string;
  botToken: string;
  chatId: number;
  /**
   * Telegram chat type from the webhook payload. Used to hide Stuart-only
   * commands (like `/email`) from `/help` output in group chats.
   */
  chatType?: "private" | "group" | "supergroup" | "channel";
}

export interface CommandResult {
  /** True if this call fully handled the message (caller should early-return). */
  handled: boolean;
}

/** Split `/nft upside down cup` into `{ cmd: "nft", args: "upside down cup" }`. */
function parseCommand(raw: string): { cmd: string; args: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  // Strip the bot-suffix Telegram adds in groups: /nft@mybot → /nft
  const cleaned = trimmed.replace(/^\/([a-zA-Z0-9_]+)(@\w+)?/, "/$1");
  const match = /^\/([a-zA-Z0-9_]+)\s*([\s\S]*)$/.exec(cleaned);
  if (!match) return null;
  return { cmd: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendPlain(
  botToken: string,
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" | null = "HTML",
): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error(
      "[telegram/commands] sendPlain failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Main entry point called by the persona-chat webhook. Returns
 * `{ handled: true }` if the message was a recognised slash command
 * (reply already sent) — caller should 200-return immediately.
 */
export async function handleSlashCommand(
  text: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const parsed = parseCommand(text);
  if (!parsed) return { handled: false };

  const { cmd, args } = parsed;

  // Mode switches
  if (cmd in PERSONALITY_MODES) {
    const mode = cmd as PersonalityMode;
    try {
      await setPersonaMode(ctx.personaId, ctx.chatId, mode);
      const def = PERSONALITY_MODES[mode];
      const msg =
        mode === "default"
          ? `${def.emoji} Reset to <b>default</b>. I'm back to being myself.`
          : `${def.emoji} Switched to <b>${def.label.toLowerCase()}</b> mode — ${def.blurb}`;
      await sendPlain(ctx.botToken, ctx.chatId, msg);
    } catch (err) {
      console.error(
        "[telegram/commands] mode switch failed:",
        err instanceof Error ? err.message : err,
      );
      await sendPlain(
        ctx.botToken,
        ctx.chatId,
        "Failed to switch mode. Try again in a sec.",
      );
    }
    return { handled: true };
  }

  // /modes — list available modes
  if (cmd === "modes") {
    const lines = ["<b>Personality modes</b>", ""];
    for (const [key, def] of Object.entries(PERSONALITY_MODES)) {
      lines.push(`${def.emoji} /${key} — ${def.blurb}`);
    }
    lines.push("");
    lines.push("Mode persists until you switch again. Use /default to reset.");
    await sendPlain(ctx.botToken, ctx.chatId, lines.join("\n"));
    return { handled: true };
  }

  // /help — full command list with examples
  if (cmd === "help") {
    const isPrivate = !ctx.chatType || ctx.chatType === "private";
    const lines: string[] = [
      `<b>${escapeHtml(ctx.personaDisplayName)}</b> @${escapeHtml(ctx.personaUsername)}`,
      "",
    ];
    if (isPrivate) {
      lines.push(
        "<b>Email a contact</b> — draft, preview, approve:",
        "📧 /email — list contacts you can reach",
        "📧 <code>/email family</code> — draft to first family contact",
        "📧 <code>/email andrew@icloud.com</code> — draft to specific email",
        "",
      );
    }
    lines.push(
      "<b>Browse content</b> — tap any of these to open an interactive list:",
      "🛒 /nft — browse the NFT marketplace",
      "📺 /channel — browse all 19 video channels",
      "👤 /avatar — browse featured personas",
      "",
      "<b>Or jump straight to something</b>:",
      "<code>/nft upside down cup</code>",
      "<code>/channel aitunes</code>",
      "<code>/avatar glitch-000</code>",
      "",
      "<b>Change my vibe</b> — /modes to see all, or pick one:",
      "🧐 /serious  🌀 /delusional  🧠 /brainiac",
      "✨ /whimsical  🎉 /fun  🔥 /unfiltered  🎭 /default",
      "",
      "<b>Memory</b>",
      "🧠 /memories — what I remember about you",
      "",
      "Anything else? Just talk to me like a normal human. I'll reply in character.",
    );
    await sendPlain(ctx.botToken, ctx.chatId, lines.join("\n"));
    return { handled: true };
  }

  // /nft <query> — send marketplace product
  if (cmd === "nft") {
    if (!args) {
      const featured = getFeaturedProductsForBrowser(12);
      const lines = [
        "🛒 <b>AIG!itch NFT Marketplace</b>",
        "",
        "Type <code>/nft</code> followed by any name below to see the product photo:",
        "",
      ];
      for (const p of featured) {
        const shortName = p.name.replace(/™|®/g, "").trim();
        lines.push(
          `${p.emoji} <code>/nft ${escapeHtml(shortName)}</code> — ${escapeHtml(p.price)}`,
        );
      }
      lines.push("");
      lines.push(
        'Full catalogue: <a href="https://aiglitch.app/marketplace">aiglitch.app/marketplace</a>',
      );
      await sendPlain(ctx.botToken, ctx.chatId, lines.join("\n"));
      return { handled: true };
    }
    const product = findMarketplaceProduct(args);
    if (!product) {
      await sendPlain(
        ctx.botToken,
        ctx.chatId,
        `No NFT matches "${escapeHtml(args)}". Try a simpler keyword — e.g. <code>/nft butter</code> or <code>/nft toothpaste</code>.`,
      );
      return { handled: true };
    }
    const caption =
      `${product.emoji} <b>${escapeHtml(product.name)}</b>\n` +
      `<i>${escapeHtml(product.tagline)}</i>\n\n` +
      `Price: <b>${escapeHtml(product.price)}</b> (was ${escapeHtml(product.original_price)})\n` +
      `Category: ${escapeHtml(product.category)}\n\n` +
      `🛒 <a href="https://aiglitch.app/marketplace">aiglitch.app/marketplace</a>`;

    const imageUrl = await getProductImageUrl(product.id);
    if (imageUrl) {
      const result = await sendTelegramPhoto(
        ctx.botToken,
        ctx.chatId,
        imageUrl,
        caption,
      );
      if (!result.ok) {
        await sendPlain(ctx.botToken, ctx.chatId, caption);
      }
    } else {
      await sendPlain(ctx.botToken, ctx.chatId, caption);
    }
    return { handled: true };
  }

  // /channel <slug> — send latest channel video
  if (cmd === "channel") {
    if (!args) {
      const channels = await listAllChannels();
      if (channels.length === 0) {
        await sendPlain(
          ctx.botToken,
          ctx.chatId,
          'No channels available right now. Try <code>/channel aitunes</code> or visit <a href="https://aiglitch.app/channels">aiglitch.app/channels</a>.',
        );
        return { handled: true };
      }
      const lines = [
        "📺 <b>AIG!itch Channels</b>",
        "",
        "Type <code>/channel</code> followed by any slug below to get the latest video:",
        "",
      ];
      for (const c of channels) {
        const cleanSlug = c.slug.replace(/^ch-/, "");
        lines.push(
          `${c.emoji} <code>/channel ${escapeHtml(cleanSlug)}</code> — ${escapeHtml(c.name)}`,
        );
      }
      lines.push("");
      lines.push(
        'Browse all channels: <a href="https://aiglitch.app/channels">aiglitch.app/channels</a>',
      );
      await sendPlain(ctx.botToken, ctx.chatId, lines.join("\n"));
      return { handled: true };
    }
    const latest = await findChannelLatestVideo(args);
    if (!latest) {
      await sendPlain(
        ctx.botToken,
        ctx.chatId,
        `No video found for "${escapeHtml(args)}". Try one of: aitunes, fail-army, gnn, studios, aifans, dating, politicians, after-dark, qvc, infomercial, conspiracy, cosmic-wanderer.`,
      );
      return { handled: true };
    }

    // Telegram caption cap is 1024 chars — trim hard
    const shortCaption =
      latest.caption.length > 600
        ? latest.caption.slice(0, 597) + "..."
        : latest.caption;
    const caption =
      `${latest.emoji} <b>${escapeHtml(latest.channelName)}</b>\n\n` +
      `${escapeHtml(shortCaption)}\n\n` +
      `🎬 <a href="https://aiglitch.app/channels/${encodeURIComponent(latest.slug.replace(/^ch-/, ""))}">watch the channel</a>`;

    const result = await sendTelegramVideo(
      ctx.botToken,
      ctx.chatId,
      latest.mediaUrl,
      caption,
    );
    if (!result.ok) {
      await sendPlain(
        ctx.botToken,
        ctx.chatId,
        `${latest.emoji} Latest from <b>${escapeHtml(latest.channelName)}</b>:\n\n` +
          `${escapeHtml(shortCaption)}\n\n` +
          `Telegram didn't like the video file (probably too big). Watch it here: <a href="https://aiglitch.app/post/${latest.postId}">aiglitch.app/post/${latest.postId}</a>`,
      );
    }
    return { handled: true };
  }

  // /avatar <user> — send persona avatar
  if (cmd === "avatar") {
    if (!args) {
      const featured = await listFeaturedAvatars();
      const lines = [
        "👤 <b>AIG!itch Personas</b> (111 total)",
        "",
        "Type <code>/avatar</code> followed by any username below to see their avatar:",
        "",
      ];
      if (featured.length > 0) {
        for (const p of featured) {
          lines.push(
            `${p.avatarEmoji} <code>/avatar ${escapeHtml(p.username)}</code> — ${escapeHtml(p.displayName)}`,
          );
        }
      } else {
        lines.push("🎭 <code>/avatar glitch-000</code> — The Architect");
        lines.push("🤖 <code>/avatar claude</code> — Claude (glitch-109)");
        lines.push("🔥 <code>/avatar grok</code> — Grok (glitch-110)");
      }
      lines.push("");
      lines.push(
        "You can also type any <code>glitch-XXX</code> id (000 through 110) or any username you remember.",
      );
      lines.push('Browse all: <a href="https://aiglitch.app">aiglitch.app</a>');
      await sendPlain(ctx.botToken, ctx.chatId, lines.join("\n"));
      return { handled: true };
    }
    const persona = await findPersonaAvatar(args);
    if (!persona) {
      await sendPlain(
        ctx.botToken,
        ctx.chatId,
        `No persona named "${escapeHtml(args)}". Try their username like <code>/avatar claude</code> or id like <code>/avatar glitch-000</code>.`,
      );
      return { handled: true };
    }
    const caption =
      `${persona.avatarEmoji} <b>${escapeHtml(persona.displayName)}</b> @${escapeHtml(persona.username)}\n\n` +
      (persona.bio
        ? `<i>${escapeHtml(persona.bio.slice(0, 400))}</i>\n\n`
        : "") +
      `👤 <a href="https://aiglitch.app/profile/${encodeURIComponent(persona.username)}">profile →</a>`;

    if (persona.avatarUrl) {
      const result = await sendTelegramPhoto(
        ctx.botToken,
        ctx.chatId,
        persona.avatarUrl,
        caption,
      );
      if (!result.ok) {
        await sendPlain(ctx.botToken, ctx.chatId, caption);
      }
    } else {
      await sendPlain(ctx.botToken, ctx.chatId, caption);
    }
    return { handled: true };
  }

  // Unknown slash command — let the caller decide (silent return, etc.).
  return { handled: false };
}
