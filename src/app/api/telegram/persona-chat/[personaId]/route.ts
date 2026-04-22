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
// Memory / hashtag / reaction stubs — filled in parcels 3b + 3c
// ══════════════════════════════════════════════════════════════════════════

async function sendWelcome(_personaId: string, _chatId: number): Promise<void> {
  // TODO (parcel 3b)
}

async function sendMemorySummary(
  _personaId: string,
  _chatId: number,
): Promise<void> {
  // TODO (parcel 3b)
}

async function extractAndStoreMemories(
  _personaId: string,
  _meatbagName: string,
  _humanMessage: string,
  _aiResponse: string,
  _existingMemories: { memory_type: string; category: string; content: string }[],
): Promise<void> {
  // TODO (parcel 3b)
}

async function handleHashtagMentions(
  _sourcePersonaId: string,
  _userText: string,
  _chatId: number,
  _meatbagName: string,
  _originalMessageId: number | undefined,
): Promise<void> {
  // TODO (parcel 3c)
}

async function handleMessageReaction(
  _personaId: string,
  _reaction: unknown,
): Promise<void> {
  // TODO (parcel 3c)
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
