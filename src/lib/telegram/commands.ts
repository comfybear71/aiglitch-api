/**
 * Telegram slash-command menus + registration.
 *
 * Minimal port of the legacy `@/lib/content/telegram-commands` —
 * command-menu registration only. The per-persona personality-mode
 * overlay system + content-surfacing command handlers stay in legacy
 * for now; they come along with the Telegram bot engine port.
 *
 * Two scoped menus are pushed via Telegram's `setMyCommands`:
 *   • `all_private_chats` — full menu, including `/email` (Stuart's
 *     outreach drafting helper).
 *   • `all_group_chats`   — the same list minus `/email`, so group
 *     members don't see a private command.
 *
 * Private-scope success is treated as the overall success signal —
 * group-scope failures are logged as warnings only.
 */

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
