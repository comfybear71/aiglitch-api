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
