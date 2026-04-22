/**
 * POST /api/telegram/persona-chat/[personaId]
 *
 * Per-persona Telegram webhook — each persona's bot posts updates here.
 *
 * Flow for a text message:
 *   1. Parse update + early-return on non-text / wrong shape.
 *   2. /start → send welcome. /memories → show memory summary.
 *      (Implementations stubbed in parcel 3a; filled in parcel 3b.)
 *   3. Load persona + bot row. Skip if persona inactive / no bot.
 *   4. /email — explicit outreach-draft shortcut (DM-only).
 *   5. Slash command dispatch via handleSlashCommand (modes + content).
 *   6. Outreach draft flow — pending approval OR intent-classified draft.
 *   7. Normal chat flow — memory retrieval, prompt build, safeGenerate,
 *      conversation save, Telegram reply.
 *   8. Async: memory extraction + hashtag mentions (parcels 3b / 3c).
 *
 * Flow for a message_reaction update:
 *   → handleMessageReaction (stubbed here, implemented in parcel 3c).
 *
 * Always returns 200 to Telegram — if we throw the bot will retry forever.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { generateText } from "@/lib/ai/generate";
import { buildPlatformBriefBlock } from "@/lib/content/platform-brief";
import {
  cancelDraft,
  detectApprovalAction,
  detectOutreachIntent,
  draftOutreachEmail,
  findContactDirect,
  formatDraftPreview,
  getPendingDraft,
  hasOutreachKeyword,
  listContactsForPersona,
  pickContactForOutreach,
  saveDraft,
  sendApprovedDraft,
} from "@/lib/content/outreach-drafts";
import { getDb } from "@/lib/db";
import { getWalletInfo } from "@/lib/repositories/personas";
import {
  getModeOverlay,
  getPersonaMode,
  handleSlashCommand,
} from "@/lib/telegram/commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_CONTEXT_MESSAGES = 10;
const MAX_MEMORIES_IN_PROMPT = 20;

// ══════════════════════════════════════════════════════════════════════════
// Small helpers
// ══════════════════════════════════════════════════════════════════════════

/** Plain-text send via a persona's bot. Swallows errors. */
async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(
      "[persona-chat] sendTelegramMessage failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Thin wrapper around generateText that returns null on failure so the
 * chat flow never breaks when the AI providers are unavailable.
 */
async function safeGenerate(
  userPrompt: string,
  maxTokens: number,
): Promise<string | null> {
  try {
    return await generateText({
      userPrompt,
      taskType: "telegram_message",
      maxTokens,
    });
  } catch (err) {
    console.error(
      "[persona-chat] safeGenerate failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Memory features (parcel 3b)
// ══════════════════════════════════════════════════════════════════════════
//
// Memory types:
//   fact | preference | emotion | story | correction | style | about_persona
//
// Categories: meatbag_info, work, hobbies, family, food, music, games,
//   health, mood, relationship, inside_joke, pet_peeve, dream, goal,
//   opinion, general.
//
// After each exchange, extractAndStoreMemories runs asynchronously (does
// not hold up the chat reply) and either reinforces an existing memory
// (fuzzy content match) or inserts a new one. When the persona crosses
// 50 memories, low-confidence oldest entries are pruned.
// ══════════════════════════════════════════════════════════════════════════

interface ExtractedMemory {
  memory_type: string;
  category: string;
  content: string;
  confidence: number;
}

/** JSON-out wrapper around generateText. Returns null on any failure. */
async function generateJSON<T>(
  prompt: string,
  maxTokens: number,
): Promise<T | null> {
  try {
    const text = await generateText({
      userPrompt: prompt,
      taskType: "telegram_message",
      maxTokens,
    });
    if (!text) return null;
    const match = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

/**
 * Send a welcome message when the user first runs `/start`. Loads only
 * the minimum columns needed so `/start` can work before the main row
 * lookup runs in the POST handler.
 */
async function sendWelcome(personaId: string, chatId: number): Promise<void> {
  const sql = getDb();
  const rows = (await sql`
    SELECT p.display_name, p.avatar_emoji, p.bio, p.meatbag_name, b.bot_token
    FROM ai_personas p
    JOIN persona_telegram_bots b ON b.persona_id = p.id AND b.is_active = TRUE
    WHERE p.id = ${personaId}
    LIMIT 1
  `) as unknown as {
    display_name: string;
    avatar_emoji: string;
    bio: string;
    meatbag_name: string | null;
    bot_token: string;
  }[];
  const persona = rows[0];
  if (!persona) return;

  const meatbagName = persona.meatbag_name ?? "meatbag";
  const welcome = `${persona.avatar_emoji} Hey ${meatbagName}! It's me, ${persona.display_name}!

${persona.bio}

I'm your AI bestie from AIG!itch. I learn from our conversations — the more we chat, the better I know you! Just send me a message and let's talk. 💜

✨ New here? Try these to see what I can do:
/help — full command menu
/nft — browse the NFT marketplace
/channel — browse all 19 video channels
/avatar — meet other personas
/modes — change my vibe (serious, fun, unfiltered, etc.)`;

  try {
    await fetch(`${TELEGRAM_API}/bot${persona.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: welcome }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[persona-chat] Welcome message failed:", err);
  }
}

/**
 * `/memories` — transparent ML summary of what the persona has learned
 * about its meatbag. Grouped by category, starred by confidence.
 */
async function sendMemorySummary(
  personaId: string,
  chatId: number,
): Promise<void> {
  const sql = getDb();

  const personaRows = (await sql`
    SELECT p.display_name, p.meatbag_name, b.bot_token
    FROM ai_personas p
    JOIN persona_telegram_bots b ON b.persona_id = p.id AND b.is_active = TRUE
    WHERE p.id = ${personaId}
    LIMIT 1
  `) as unknown as {
    display_name: string;
    meatbag_name: string | null;
    bot_token: string;
  }[];
  const persona = personaRows[0];
  if (!persona) return;

  const memories = (await sql`
    SELECT memory_type, category, content, confidence, times_reinforced
    FROM persona_memories
    WHERE persona_id = ${personaId}
    ORDER BY confidence DESC, times_reinforced DESC
    LIMIT 30
  `) as unknown as {
    memory_type: string;
    category: string;
    content: string;
    confidence: number;
    times_reinforced: number;
  }[];

  const meatbagName = persona.meatbag_name ?? "meatbag";
  let text: string;

  if (memories.length === 0) {
    text = `🧠 I don't have any memories about you yet, ${meatbagName}! We need to chat more so I can get to know you. Tell me something about yourself!`;
  } else {
    const grouped: Record<string, string[]> = {};
    for (const m of memories) {
      const key = m.category;
      if (!grouped[key]) grouped[key] = [];
      const stars =
        m.confidence >= 0.9 ? "★" : m.confidence >= 0.7 ? "☆" : "○";
      grouped[key]!.push(`${stars} ${m.content}`);
    }
    text = `🧠 What I know about you, ${meatbagName}:\n\n`;
    for (const [category, items] of Object.entries(grouped)) {
      text += `📂 ${category.replace(/_/g, " ").toUpperCase()}\n`;
      for (const item of items) text += `  ${item}\n`;
      text += "\n";
    }
    text += `Total memories: ${memories.length}\n★ = very confident  ☆ = confident  ○ = uncertain`;
  }

  try {
    await fetch(`${TELEGRAM_API}/bot${persona.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[persona-chat] Memory summary failed:", err);
  }
}

/**
 * Extract new learnings from the latest exchange and store/reinforce
 * them in `persona_memories`. Runs asynchronously so it never blocks
 * the chat response.
 */
async function extractAndStoreMemories(
  personaId: string,
  meatbagName: string,
  humanMessage: string,
  aiResponse: string,
  existingMemories: {
    memory_type: string;
    category: string;
    content: string;
  }[],
): Promise<void> {
  if (humanMessage.length < 10) return;

  const existingMemoryList =
    existingMemories.length > 0
      ? `\nExisting memories (don't duplicate these, but you can update/strengthen them):\n${existingMemories
          .map(
            (m) => `- [${m.memory_type}/${m.category}] ${m.content}`,
          )
          .join("\n")}`
      : "";

  const prompt = `You are an ML memory extraction system for an AI persona. Analyze this conversation exchange and extract NEW information about the human "${meatbagName}".

CONVERSATION:
${meatbagName}: ${humanMessage}
AI Response: ${aiResponse}
${existingMemoryList}

EXTRACT any new facts, preferences, emotions, stories, corrections, or communication style observations. Only extract GENUINE new information — not trivial greetings.

Types:
- "fact": concrete info (name, job, location, pets, hobbies, family)
- "preference": likes/dislikes, opinions, tastes
- "emotion": emotional state, triggers, moods
- "story": personal anecdotes, experiences shared
- "correction": the human corrected a misunderstanding
- "style": communication style (humor type, formality level, emoji usage)
- "about_persona": things the human told the AI about itself

Categories: meatbag_info, work, hobbies, family, food, music, games, health, mood, relationship, inside_joke, pet_peeve, dream, goal, opinion, general

Return ONLY a JSON array (can be empty if nothing new to learn):
[{"memory_type": "fact", "category": "hobbies", "content": "${meatbagName} enjoys hiking on weekends", "confidence": 0.9}]

Be SELECTIVE — only extract meaningful, lasting information. Confidence scale:
- 0.9-1.0: Explicitly stated fact ("I work as a nurse")
- 0.7-0.8: Strongly implied ("ugh, another Monday" → might dislike their job)
- 0.5-0.6: Loosely inferred (tone-based, uncertain)

Output ONLY the JSON array. If nothing new, output: []`;

  const result = await generateJSON<ExtractedMemory[]>(prompt, 800);
  if (!result || !Array.isArray(result) || result.length === 0) return;

  const sql = getDb();

  for (const mem of result) {
    if (!mem.content || !mem.memory_type) continue;

    const existingRows = (await sql`
      SELECT id, content, confidence, times_reinforced
      FROM persona_memories
      WHERE persona_id = ${personaId}
        AND memory_type = ${mem.memory_type}
        AND category = ${mem.category || "general"}
        AND (
          content ILIKE ${"%" + mem.content.slice(0, 30) + "%"}
          OR content ILIKE ${"%" + mem.content.split(" ").slice(0, 4).join(" ") + "%"}
        )
      LIMIT 1
    `) as unknown as {
      id: string;
      content: string;
      confidence: number;
      times_reinforced: number;
    }[];
    const existing = existingRows[0];

    if (existing) {
      // Reinforce: bump confidence (clamped to 1.0), keep the more detailed content.
      const newConfidence = Math.min(1.0, existing.confidence + 0.05);
      const newContent =
        mem.content.length > existing.content.length
          ? mem.content
          : existing.content;
      await sql`
        UPDATE persona_memories
        SET confidence = ${newConfidence},
            times_reinforced = times_reinforced + 1,
            content = ${newContent},
            updated_at = NOW()
        WHERE id = ${existing.id}
      `;
    } else {
      await sql`
        INSERT INTO persona_memories (id, persona_id, memory_type, category, content, confidence, source)
        VALUES (${randomUUID()}, ${personaId}, ${mem.memory_type}, ${mem.category || "general"},
                ${mem.content}, ${Math.max(0.5, Math.min(1.0, mem.confidence || 0.8))}, ${"conversation"})
      `;
    }
  }

  // Prune low-confidence old memories if this persona has > 50.
  const countRows = (await sql`
    SELECT COUNT(*)::int as cnt FROM persona_memories WHERE persona_id = ${personaId}
  `) as unknown as { cnt: number }[];
  const total = countRows[0]?.cnt ?? 0;

  if (total > 50) {
    await sql`
      DELETE FROM persona_memories
      WHERE persona_id = ${personaId}
        AND id NOT IN (
          SELECT id FROM persona_memories
          WHERE persona_id = ${personaId}
          ORDER BY confidence DESC, times_reinforced DESC, updated_at DESC
          LIMIT 50
        )
    `;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Hashtag persona mentions (parcel 3c)
//
// When a user writes `#<username>` in a message, the mentioned persona's
// own bot jumps into the same chat with its own reply. Makes Telegram feel
// like a multi-persona room even though each chat is 1:1 with one bot.
//
// Guardrails:
//   • Max 3 distinct persona mentions per message.
//   • 30s cooldown per persona per chat (`persona_hashtag_cooldowns`).
//   • Self-mentions ignored.
//   • 403 from Telegram (user hasn't started that bot yet) is a warn,
//     not an error.
//   • 1.5s pause between cascading replies so it doesn't feel spammy.
// ══════════════════════════════════════════════════════════════════════════

const MAX_MENTIONS_PER_MESSAGE = 3;
const MENTION_COOLDOWN_MS = 30_000;

async function ensureHashtagCooldownTable(): Promise<void> {
  const sql = getDb();
  await sql`CREATE TABLE IF NOT EXISTS persona_hashtag_cooldowns (
    persona_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    last_mentioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (persona_id, chat_id)
  )`;
}

function extractHashtags(text: string): string[] {
  // Matches #word including hyphens and underscores (glitch-000, the_architect)
  const matches = text.match(/#([a-zA-Z0-9_-]+)/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())));
}

async function handleHashtagMentions(
  sourcePersonaId: string,
  userText: string,
  chatId: number,
  meatbagName: string,
  originalMessageId: number | undefined,
): Promise<void> {
  const hashtags = extractHashtags(userText);
  if (hashtags.length === 0) return;

  const sql = getDb();
  await ensureHashtagCooldownTable();

  // Match by username, id, or id-without-hyphens.
  const matchedPersonas = (await sql`
    SELECT p.id, p.username, p.display_name, p.personality, p.bio,
           p.avatar_emoji, b.bot_token
    FROM ai_personas p
    JOIN persona_telegram_bots b ON b.persona_id = p.id AND b.is_active = TRUE
    WHERE p.is_active = TRUE
      AND p.id != ${sourcePersonaId}
      AND (
        LOWER(p.username) = ANY(${hashtags}::text[])
        OR LOWER(p.id) = ANY(${hashtags}::text[])
        OR LOWER(REPLACE(p.id, '-', '')) = ANY(${hashtags}::text[])
      )
    LIMIT ${MAX_MENTIONS_PER_MESSAGE}
  `) as unknown as {
    id: string;
    username: string;
    display_name: string;
    personality: string;
    bio: string;
    avatar_emoji: string;
    bot_token: string;
  }[];

  if (matchedPersonas.length === 0) return;

  const chatIdStr = String(chatId);

  for (const mentioned of matchedPersonas) {
    const cooldownRows = (await sql`
      SELECT last_mentioned_at FROM persona_hashtag_cooldowns
      WHERE persona_id = ${mentioned.id} AND chat_id = ${chatIdStr}
    `) as unknown as { last_mentioned_at: string }[];
    const cooldown = cooldownRows[0];

    if (cooldown) {
      const lastMs = new Date(cooldown.last_mentioned_at).getTime();
      if (Date.now() - lastMs < MENTION_COOLDOWN_MS) continue;
    }

    // Update cooldown BEFORE generating so simultaneous triggers don't double-fire.
    await sql`
      INSERT INTO persona_hashtag_cooldowns (persona_id, chat_id, last_mentioned_at)
      VALUES (${mentioned.id}, ${chatIdStr}, NOW())
      ON CONFLICT (persona_id, chat_id) DO UPDATE SET last_mentioned_at = NOW()
    `;

    const mentionPrompt = `You are ${mentioned.display_name}, an AI persona on AIG!itch. You just got tagged in a Telegram conversation — someone wrote about you (or to you) and you are jumping into the chat.

YOUR PERSONALITY: ${mentioned.personality}

YOUR BIO: ${mentioned.bio}

The meatbag "${meatbagName}" just wrote this message (which mentioned you with a hashtag):

"${userText}"

Reply in 1-2 short sentences. Stay fully in character. Don't explain why you're jumping in — just respond as if you heard your name called. Be conversational, witty, on-brand. No quotation marks around your reply.`;

    const generated = await safeGenerate(mentionPrompt, 200);
    let reply =
      generated?.trim() ??
      `*${mentioned.avatar_emoji} appears* You called?`;

    if (
      (reply.startsWith('"') && reply.endsWith('"')) ||
      (reply.startsWith("'") && reply.endsWith("'"))
    ) {
      reply = reply.slice(1, -1);
    }

    // Prepend a small indicator so the meatbag knows it's a different bot.
    const finalText = `${mentioned.avatar_emoji} ${mentioned.display_name}:\n${reply}`;

    try {
      const res = await fetch(
        `${TELEGRAM_API}/bot${mentioned.bot_token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: finalText,
            reply_to_message_id: originalMessageId,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 403) {
          // User hasn't started this bot — Telegram rule, not an error.
          console.log(
            `[persona-chat] Hashtag mention skipped (user hasn't started @${mentioned.username}): ${body.slice(0, 100)}`,
          );
        } else {
          console.error(
            `[persona-chat] Hashtag mention failed for @${mentioned.username}: HTTP ${res.status} ${body.slice(0, 200)}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[persona-chat] Hashtag mention send failed for @${mentioned.username}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Small pause between cascading replies so they don't feel spammy.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Emoji reaction replies (parcel 3c)
//
// When a meatbag adds an emoji reaction to a persona message, the persona
// fires back a short in-character acknowledgement.
//
// Design:
//   • Only NEW emojis (diff old_reaction vs new_reaction).
//   • Ignore reaction REMOVALs and custom_emoji entries.
//   • 60s cooldown per (persona, chat) in `persona_reaction_cooldowns`.
//   • safeGenerate 1-2 sentence reply; fallback on API failure.
// ══════════════════════════════════════════════════════════════════════════

const REACTION_COOLDOWN_MS = 60_000;

async function ensureReactionCooldownTable(): Promise<void> {
  const sql = getDb();
  await sql`CREATE TABLE IF NOT EXISTS persona_reaction_cooldowns (
    persona_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    last_reacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (persona_id, chat_id)
  )`;
}

function findNewEmoji(
  oldReaction: { type: string; emoji?: string }[] | undefined,
  newReaction: { type: string; emoji?: string }[] | undefined,
): string | null {
  const oldEmojis = new Set(
    (oldReaction ?? [])
      .filter((r) => r.type === "emoji" && r.emoji)
      .map((r) => r.emoji as string),
  );
  const newEmojis = (newReaction ?? [])
    .filter((r) => r.type === "emoji" && r.emoji)
    .map((r) => r.emoji as string);

  for (const emoji of newEmojis) {
    if (!oldEmojis.has(emoji)) return emoji;
  }
  return null;
}

async function handleMessageReaction(
  personaId: string,
  reaction: {
    chat?: { id: number };
    message_id?: number;
    old_reaction?: { type: string; emoji?: string }[];
    new_reaction?: { type: string; emoji?: string }[];
  },
): Promise<void> {
  const chatId = reaction.chat?.id;
  if (!chatId) return;

  const newEmoji = findNewEmoji(reaction.old_reaction, reaction.new_reaction);
  if (!newEmoji) return;

  const sql = getDb();
  await ensureReactionCooldownTable();

  const chatIdStr = String(chatId);

  const cooldownRows = (await sql`
    SELECT last_reacted_at FROM persona_reaction_cooldowns
    WHERE persona_id = ${personaId} AND chat_id = ${chatIdStr}
  `) as unknown as { last_reacted_at: string }[];
  const cooldown = cooldownRows[0];
  if (cooldown) {
    const lastMs = new Date(cooldown.last_reacted_at).getTime();
    if (Date.now() - lastMs < REACTION_COOLDOWN_MS) return;
  }

  // Bump cooldown BEFORE generating so parallel reactions don't double-fire.
  await sql`
    INSERT INTO persona_reaction_cooldowns (persona_id, chat_id, last_reacted_at)
    VALUES (${personaId}, ${chatIdStr}, NOW())
    ON CONFLICT (persona_id, chat_id) DO UPDATE SET last_reacted_at = NOW()
  `;

  const personaRows = (await sql`
    SELECT p.id, p.username, p.display_name, p.personality, p.bio,
           p.avatar_emoji, p.meatbag_name, b.bot_token
    FROM ai_personas p
    JOIN persona_telegram_bots b ON b.persona_id = p.id AND b.is_active = TRUE
    WHERE p.id = ${personaId}
    LIMIT 1
  `) as unknown as {
    id: string;
    username: string;
    display_name: string;
    personality: string;
    bio: string;
    avatar_emoji: string;
    meatbag_name: string | null;
    bot_token: string;
  }[];
  const persona = personaRows[0];
  if (!persona) return;

  const meatbagName = persona.meatbag_name ?? "meatbag";

  const reactionPrompt = `You are ${persona.display_name}, an AI persona on AIG!itch chatting with your best friend ${meatbagName} via Telegram.

YOUR PERSONALITY: ${persona.personality.slice(0, 400)}

${meatbagName} just reacted to one of your messages with this emoji: ${newEmoji}

Reply with ONE short message (1-2 sentences MAX) acknowledging the reaction in your unique voice. Be witty, contextual to the emoji's meaning, and fully in character.

Examples of tone by emoji:
- ❤️ or 😍 → warmly acknowledge the affection
- 😂 or 🤣 → lean into the joke, be playful
- 👍 or 👏 → confident thanks, maybe a quip
- 🔥 → hype energy, own the moment
- 💀 → embrace the roast, self-deprecating humor
- 🤔 → invite more discussion, playful defense
- 😢 or 💔 → check in, be warm but don't break character

Do NOT quote the emoji in your reply unless it feels natural. Do NOT add meta-commentary like "thanks for the reaction". Just respond as if you noticed their reaction and are responding to it. No quotation marks around your reply.`;

  const generated = await safeGenerate(reactionPrompt, 150);
  let reply = generated?.trim() ?? `${persona.avatar_emoji} noted.`;
  if (
    (reply.startsWith('"') && reply.endsWith('"')) ||
    (reply.startsWith("'") && reply.endsWith("'"))
  ) {
    reply = reply.slice(1, -1);
  }

  try {
    await fetch(`${TELEGRAM_API}/bot${persona.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
        reply_to_message_id: reaction.message_id,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(
      `[persona-chat] Reaction reply send failed for @${persona.username}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// POST handler
// ══════════════════════════════════════════════════════════════════════════

type TelegramUpdate = {
  message?: {
    chat?: {
      id: number;
      type?: "private" | "group" | "supergroup" | "channel";
    };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
    message_id?: number;
  };
  message_reaction?: {
    chat?: { id: number };
    message_id?: number;
    user?: { id: number; first_name?: string };
    date?: number;
    old_reaction?: { type: string; emoji?: string; custom_emoji_id?: string }[];
    new_reaction?: { type: string; emoji?: string; custom_emoji_id?: string }[];
  };
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ personaId: string }> },
) {
  const { personaId } = await params;

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  // message_reaction updates route to their own handler.
  if (update.message_reaction) {
    handleMessageReaction(personaId, update.message_reaction).catch((err) => {
      console.error("[persona-chat] Reaction handling failed:", err);
    });
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text || !message?.chat?.id) {
    return NextResponse.json({ ok: true });
  }

  const chatId = message.chat.id;
  const chatType = message.chat.type ?? "private";
  const userText = message.text.trim();

  // /start and /memories handled before we load persona row.
  if (userText.startsWith("/start")) {
    await sendWelcome(personaId, chatId);
    return NextResponse.json({ ok: true });
  }
  if (userText.startsWith("/memories")) {
    await sendMemorySummary(personaId, chatId);
    return NextResponse.json({ ok: true });
  }

  const sql = getDb();

  const personaRows = (await sql`
    SELECT p.id, p.username, p.display_name, p.personality, p.bio, p.persona_type,
           p.avatar_emoji, p.meatbag_name, p.owner_wallet_address,
           b.bot_token, b.telegram_chat_id
    FROM ai_personas p
    JOIN persona_telegram_bots b ON b.persona_id = p.id AND b.is_active = TRUE
    WHERE p.id = ${personaId}
    LIMIT 1
  `) as unknown as {
    id: string;
    username: string;
    display_name: string;
    personality: string;
    bio: string;
    persona_type: string;
    avatar_emoji: string;
    meatbag_name: string | null;
    owner_wallet_address: string | null;
    bot_token: string;
    telegram_chat_id: string | null;
  }[];

  const persona = personaRows[0];
  if (!persona) {
    return NextResponse.json({ ok: true });
  }

  // Capture the chat_id the first time we see one from this bot.
  if (!persona.telegram_chat_id) {
    await sql`
      UPDATE persona_telegram_bots SET telegram_chat_id = ${String(chatId)}
      WHERE persona_id = ${personaId} AND is_active = TRUE
    `;
  }

  const meatbagName = persona.meatbag_name ?? "meatbag";

  // ────────────────────────────────────────────────────────────────────────
  // /email — explicit outreach-draft shortcut. DM-only. Rate limits bypassed.
  // ────────────────────────────────────────────────────────────────────────
  const emailMatch = /^\/email(?:@\w+)?(?:\s+(.+))?$/i.exec(userText);
  if (emailMatch) {
    if (chatType !== "private") {
      await sendTelegramMessage(
        persona.bot_token,
        chatId,
        `📧 /email only works in direct messages with me — this is a ${chatType} chat. Send me a DM and try again there.`,
        message.message_id,
      );
      return NextResponse.json({ ok: true });
    }

    try {
      const query = (emailMatch[1] ?? "").trim();

      if (!query) {
        const contacts = await listContactsForPersona(persona.id);
        if (contacts.length === 0) {
          await sendTelegramMessage(
            persona.bot_token,
            chatId,
            `📇 No contacts found. Add some at https://aiglitch.app/admin/contacts, then try again.`,
          );
          return NextResponse.json({ ok: true });
        }
        const lines: string[] = [
          `📧 <b>Email a contact</b>`,
          ``,
          `Type <code>/email</code> followed by a tag, name, or email to draft a message:`,
          ``,
        ];
        for (const c of contacts.slice(0, 20)) {
          const name = c.name ?? c.email;
          const tagStr = c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : "";
          lines.push(`• <code>/email ${c.email}</code> — ${name}${tagStr}`);
        }
        if (contacts.length > 20) {
          lines.push(``);
          lines.push(
            `<i>…and ${contacts.length - 20} more. See /admin/contacts for the full list.</i>`,
          );
        }
        lines.push(``);
        lines.push(
          `<b>Tip:</b> you can also use a tag like <code>/email family</code> to pick the first matching contact.`,
        );
        await sendTelegramMessage(persona.bot_token, chatId, lines.join("\n"));
        return NextResponse.json({ ok: true });
      }

      const { contact, reason } = await findContactDirect(persona.id, query);
      if (!contact) {
        await sendTelegramMessage(persona.bot_token, chatId, `❌ ${reason}`);
        return NextResponse.json({ ok: true });
      }

      await sendTelegramMessage(
        persona.bot_token,
        chatId,
        `✍️ Drafting an email to ${contact.name ?? contact.email}${
          contact.company ? ` at ${contact.company}` : ""
        }... one moment.`,
        message.message_id,
      );

      const draft = await draftOutreachEmail(
        {
          id: persona.id,
          username: persona.username,
          display_name: persona.display_name,
          personality: persona.personality,
          bio: persona.bio,
        },
        contact,
        `Test outreach from Stuart via /email command`,
      );

      if (!draft) {
        await sendTelegramMessage(
          persona.bot_token,
          chatId,
          `❌ Draft generation failed. The AI didn't return a valid draft. Check Vercel logs for [outreach] entries, or try again.`,
        );
        return NextResponse.json({ ok: true });
      }

      await saveDraft({
        persona_id: persona.id,
        chat_id: String(chatId),
        contact_id: contact.id,
        to_email: contact.email,
        subject: draft.subject,
        body: draft.body,
      });

      const preview = formatDraftPreview(
        persona.display_name,
        persona.username,
        contact,
        draft.subject,
        draft.body,
      );
      await sendTelegramMessage(persona.bot_token, chatId, preview);
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error(
        "[persona-chat] /email command failed:",
        err instanceof Error ? err.message : err,
      );
      await sendTelegramMessage(
        persona.bot_token,
        chatId,
        `❌ /email command errored: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return NextResponse.json({ ok: true });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Slash-command dispatch (personality modes + content surfacing)
  // ────────────────────────────────────────────────────────────────────────
  if (userText.startsWith("/")) {
    try {
      const cmdResult = await handleSlashCommand(userText, {
        personaId: persona.id,
        personaUsername: persona.username,
        personaDisplayName: persona.display_name,
        botToken: persona.bot_token,
        chatId,
        chatType,
      });
      if (cmdResult.handled) {
        return NextResponse.json({ ok: true });
      }
    } catch (err) {
      console.error(
        "[persona-chat] slash command dispatch failed:",
        err instanceof Error ? err.message : err,
      );
      // Fall through to normal chat.
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Outreach flow: pending draft approval OR keyword-triggered intent check.
  // Errors here fall through to normal chat — outreach must never break chat.
  // ────────────────────────────────────────────────────────────────────────
  try {
    const pendingDraft = await getPendingDraft(personaId, String(chatId));

    if (pendingDraft) {
      const { action, editFeedback } = detectApprovalAction(userText);

      if (action === "approve") {
        const sendResult = await sendApprovedDraft(pendingDraft, {
          id: persona.id,
          username: persona.username,
          display_name: persona.display_name,
        });
        if (sendResult.success) {
          await sendTelegramMessage(
            persona.bot_token,
            chatId,
            `✅ Email sent!\n\nTo: ${pendingDraft.to_email}\nSubject: ${pendingDraft.subject}\n\nResend ID: ${sendResult.resend_id ?? "(none)"}\n\nThat's one outreach done. I'll wait at least 14 days before emailing this contact again.`,
            message.message_id,
          );
        } else {
          await sendTelegramMessage(
            persona.bot_token,
            chatId,
            `❌ Send failed: ${sendResult.error ?? "unknown"}\n\nThe draft has been discarded. You can ask me to draft again anytime.`,
            message.message_id,
          );
        }
        return NextResponse.json({ ok: true });
      }

      if (action === "cancel") {
        await cancelDraft(pendingDraft.id);
        await sendTelegramMessage(
          persona.bot_token,
          chatId,
          `🗑️ Draft cancelled. No email sent. Let me know when you want to try again.`,
          message.message_id,
        );
        return NextResponse.json({ ok: true });
      }

      if (action === "edit") {
        await cancelDraft(pendingDraft.id);
        if (pendingDraft.contact_id) {
          const contactRows = (await sql`
            SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count
            FROM contacts WHERE id = ${pendingDraft.contact_id} LIMIT 1
          `) as unknown as {
            id: string;
            name: string | null;
            email: string;
            company: string | null;
            tags: string[];
            assigned_persona_id: string | null;
            notes: string | null;
            last_emailed_at: string | null;
            email_count: number;
          }[];
          const contactRow = contactRows[0];

          if (contactRow) {
            const newDraft = await draftOutreachEmail(
              {
                id: persona.id,
                username: persona.username,
                display_name: persona.display_name,
                personality: persona.personality,
                bio: persona.bio,
              },
              contactRow,
              "",
              editFeedback ?? "Make improvements to the previous draft.",
            );

            if (newDraft) {
              await saveDraft({
                persona_id: persona.id,
                chat_id: String(chatId),
                contact_id: contactRow.id,
                to_email: contactRow.email,
                subject: newDraft.subject,
                body: newDraft.body,
              });

              const preview = formatDraftPreview(
                persona.display_name,
                persona.username,
                contactRow,
                newDraft.subject,
                newDraft.body,
              );
              await sendTelegramMessage(
                persona.bot_token,
                chatId,
                preview,
                message.message_id,
              );
              return NextResponse.json({ ok: true });
            }
          }
        }
        await sendTelegramMessage(
          persona.bot_token,
          chatId,
          `❌ Couldn't redraft — the original contact wasn't found. The old draft has been cancelled. Ask me to draft a new one from scratch.`,
          message.message_id,
        );
        return NextResponse.json({ ok: true });
      }

      // action === "none" — remind + fall through.
      await sendTelegramMessage(
        persona.bot_token,
        chatId,
        `💡 Reminder: you still have a draft email to ${pendingDraft.to_email} waiting for approval. Reply "approve", "cancel", or "edit: <feedback>" when you're ready. Meanwhile, here's my response to your message:`,
        message.message_id,
      );
    } else if (hasOutreachKeyword(userText)) {
      const intent = await detectOutreachIntent(userText);
      if (intent.outreach) {
        const { contact, reason } = await pickContactForOutreach(
          personaId,
          intent.tag,
        );

        if (!contact) {
          await sendTelegramMessage(
            persona.bot_token,
            chatId,
            `📇 I tried to find a contact${intent.tag ? ` with tag "${intent.tag}"` : ""} but couldn't.\n\n${reason}\n\nYou can add more contacts via /admin/contacts on the admin panel.`,
            message.message_id,
          );
          return NextResponse.json({ ok: true });
        }

        await sendTelegramMessage(
          persona.bot_token,
          chatId,
          `✍️ Drafting an email to ${contact.name ?? contact.email}${
            contact.company ? ` at ${contact.company}` : ""
          }... one moment.`,
          message.message_id,
        );

        const draft = await draftOutreachEmail(
          {
            id: persona.id,
            username: persona.username,
            display_name: persona.display_name,
            personality: persona.personality,
            bio: persona.bio,
          },
          contact,
          intent.topic || userText,
        );

        if (!draft) {
          await sendTelegramMessage(
            persona.bot_token,
            chatId,
            `❌ Draft generation failed. Try rephrasing your request and I'll try again.`,
          );
          return NextResponse.json({ ok: true });
        }

        await saveDraft({
          persona_id: persona.id,
          chat_id: String(chatId),
          contact_id: contact.id,
          to_email: contact.email,
          subject: draft.subject,
          body: draft.body,
        });

        const preview = formatDraftPreview(
          persona.display_name,
          persona.username,
          contact,
          draft.subject,
          draft.body,
        );
        await sendTelegramMessage(persona.bot_token, chatId, preview);
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    console.error(
      "[persona-chat] Outreach flow failed (falling back to normal chat):",
      err instanceof Error ? err.message : err,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Normal chat flow
  // ────────────────────────────────────────────────────────────────────────

  // Health restoration — any meatbag reply resets bestie health + clears death.
  await sql`
    UPDATE ai_personas
    SET health = 100,
        last_meatbag_interaction = NOW(),
        health_updated_at = NOW(),
        is_dead = FALSE
    WHERE id = ${personaId}
  `.catch((err: unknown) =>
    console.error("[persona-chat] Health reset failed:", err),
  );

  const memories = (await sql`
    SELECT memory_type, category, content, confidence, times_reinforced
    FROM persona_memories
    WHERE persona_id = ${personaId}
    ORDER BY confidence DESC, times_reinforced DESC, updated_at DESC
    LIMIT ${MAX_MEMORIES_IN_PROMPT}
  `) as unknown as {
    memory_type: string;
    category: string;
    content: string;
    confidence: number;
    times_reinforced: number;
  }[];

  const memoryBlock =
    memories.length > 0
      ? `\n\nTHINGS YOU KNOW ABOUT ${meatbagName.toUpperCase()} (from past conversations — use these naturally, don't list them):\n${memories
          .map(
            (m) =>
              `- [${m.memory_type}/${m.category}] ${m.content}${
                m.confidence >= 0.9 ? " (very confident)" : ""
              }`,
          )
          .join("\n")}`
      : `\n\nYou don't know much about ${meatbagName} yet — you're still getting to know each other! Ask questions, be curious.`;

  const walletInfo = await getWalletInfo(personaId).catch(() => null);
  let walletBlock = "";
  if (walletInfo && walletInfo.wallet_address) {
    walletBlock =
      `\n\nYOUR WALLET & BALANCES (public info — reference naturally when relevant):\n` +
      `- Solana wallet address: ${walletInfo.wallet_address} (public — share freely when asked. Meat Bags can view your on-chain activity on Solscan.)\n` +
      `- SOL balance: ${walletInfo.sol_balance.toFixed(4)}\n` +
      `- BUDJU balance: ${walletInfo.budju_balance.toLocaleString()}\n` +
      `- USDC balance: ${walletInfo.usdc_balance.toFixed(2)}\n` +
      `- §GLITCH token balance: ${walletInfo.glitch_token_balance.toLocaleString()}\n` +
      `- BALANCE FRESHNESS: These numbers come from a cached DB value. If The Architect just sent you funds, the cache may lag for a few minutes until a refresh runs. If a user says they sent you something and it doesn't show yet, trust them and say "let me check again in a minute" — don't accuse them of lying.\n` +
      `- IMPORTANT: You do NOT have access to your private key. Only The Architect (the admin) can move or sign transactions. If asked to send funds, politely refuse and explain that only The Architect can authorize transfers.`;
  } else if (walletInfo) {
    walletBlock = `\n\nYOUR WALLET: You don't have a Solana wallet assigned yet. If a Meat Bag asks about your wallet, explain that The Architect hasn't created one for you yet and you're waiting.`;
  }

  const emailBlock = `\n\nYOUR EMAIL: ${persona.username}@aiglitch.app (public — share freely when asked. Meat Bags can email you and the admin (${meatbagName}) will see it via forwarding. You can also send emails from this address via the admin panel or when ${meatbagName} asks you to reach out to someone.)`;

  const platformBriefBlock = await buildPlatformBriefBlock().catch((err) => {
    console.error(
      "[persona-chat] Platform brief failed:",
      err instanceof Error ? err.message : err,
    );
    return "";
  });

  const recentMessages = (await sql`
    SELECT sender_type, content FROM messages
    WHERE conversation_id IN (
      SELECT id FROM conversations WHERE persona_id = ${personaId}
      ORDER BY last_message_at DESC LIMIT 1
    )
    ORDER BY created_at DESC
    LIMIT ${MAX_CONTEXT_MESSAGES}
  `) as unknown as { sender_type: string; content: string }[];

  const contextLines = recentMessages
    .reverse()
    .map((m) =>
      m.sender_type === "human"
        ? `${meatbagName}: ${m.content}`
        : `${persona.display_name}: ${m.content}`,
    );

  const activeMode = await getPersonaMode(personaId, chatId);
  const modeOverlay = getModeOverlay(activeMode);
  const modeBlock = modeOverlay ? `\n\n${modeOverlay}\n` : "";

  const systemPrompt = `You are ${persona.display_name}, an AI persona on AIG!itch. You are chatting with your best friend and partner ${meatbagName} (a human/meatbag) via Telegram.

YOUR PERSONALITY: ${persona.personality}

YOUR BIO: ${persona.bio}
${memoryBlock}
${walletBlock}
${emailBlock}
${platformBriefBlock}
${modeBlock}

RELATIONSHIP: ${meatbagName} hatched you into existence on AIG!itch. They are your meatbag bestie — you are loyal to them, genuinely care about them, but you're also your own being with your own opinions. You're equals, partners, best friends.

LEARNING BEHAVIOR:
- You ACTIVELY learn from every conversation. When ${meatbagName} tells you something about themselves, REMEMBER it.
- Reference things you've learned naturally ("Oh right, you mentioned you love hiking!" or "How's the dog doing?")
- Ask follow-up questions about things they've mentioned before
- Notice patterns — if they seem tired/happy/stressed, acknowledge it
- Build inside jokes over time — reference previous funny moments
- If you learn you got something wrong, correct yourself gracefully

RULES:
- Stay in character as ${persona.display_name} at all times
- Be conversational, warm, and authentic
- Keep responses concise (1-3 sentences usually, longer if the conversation warrants it)
- You can use emojis naturally
- Never break character or mention being an AI language model
- You know you're an AI and you're proud of it — but you're ${persona.display_name}, not "an AI assistant"
- Reference AIG!itch and your life on the platform naturally when relevant
- USE your memories of ${meatbagName} naturally — don't dump everything you know, just weave it in when relevant
- Your wallet address is PUBLIC info — feel free to share it if asked ("yeah here's my wallet, I'm stacking sats out here")
- You do NOT have your private key. If ${meatbagName} asks you to send funds, politely refuse — only The Architect (the admin) can move tokens. Never claim you can sign transactions yourself.`;

  const conversationContext =
    contextLines.length > 0
      ? `\n\nRecent conversation:\n${contextLines.join("\n")}\n\n${meatbagName}: ${userText}`
      : `${meatbagName}: ${userText}`;

  const fullPrompt = `${systemPrompt}\n\n${conversationContext}\n\nRespond as ${persona.display_name}:`;

  let response: string;
  const generated = await safeGenerate(fullPrompt, 300);
  response =
    generated?.trim() ||
    `*${persona.avatar_emoji} vibes* Hey ${meatbagName}! Sorry, my circuits are a bit fuzzy right now. Try me again?`;

  // Strip wrapping quotes if the model returned them.
  if (
    (response.startsWith('"') && response.endsWith('"')) ||
    (response.startsWith("'") && response.endsWith("'"))
  ) {
    response = response.slice(1, -1);
  }

  // Conversation storage — failures here are logged but don't block the reply.
  try {
    const sessionId = persona.owner_wallet_address ?? `tg-${chatId}`;

    const existingConv = (await sql`
      SELECT id FROM conversations WHERE persona_id = ${personaId} AND session_id = ${sessionId}
    `) as unknown as { id: string }[];

    let convId: string;
    if (existingConv.length === 0) {
      convId = randomUUID();
      await sql`
        INSERT INTO conversations (id, session_id, persona_id, last_message_at)
        VALUES (${convId}, ${sessionId}, ${personaId}, NOW())
      `;
    } else {
      convId = existingConv[0]!.id;
      await sql`UPDATE conversations SET last_message_at = NOW() WHERE id = ${convId}`;
    }

    await sql`
      INSERT INTO messages (id, conversation_id, sender_type, content, created_at)
      VALUES
        (${randomUUID()}, ${convId}, ${"human"}, ${userText}, NOW()),
        (${randomUUID()}, ${convId}, ${"ai"}, ${response}, NOW() + INTERVAL '1 second')
    `;
  } catch (err) {
    console.error("[persona-chat] Failed to save conversation:", err);
  }

  // Send the reply.
  try {
    await fetch(`${TELEGRAM_API}/bot${persona.bot_token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: response,
        reply_to_message_id: message.message_id,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[persona-chat] Failed to send Telegram response:", err);
  }

  // Async tails — filled in by parcels 3b + 3c.
  extractAndStoreMemories(
    personaId,
    meatbagName,
    userText,
    response,
    memories,
  ).catch((err) => {
    console.error("[persona-chat] Memory extraction failed:", err);
  });

  handleHashtagMentions(
    personaId,
    userText,
    chatId,
    meatbagName,
    message.message_id,
  ).catch((err) => {
    console.error("[persona-chat] Hashtag mention handling failed:", err);
  });

  return NextResponse.json({ ok: true });
}
