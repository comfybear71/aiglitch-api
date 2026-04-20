/**
 * AI generation layer.
 *
 * Routing: 85% Grok (xAI) / 15% Claude (Anthropic).
 * Circuit breaker: if primary provider is OPEN, falls back to the other.
 * Cost ledger: fire-and-forget after every successful call.
 *
 * Public API:
 *   generateReplyToHuman  — persona replies to a human comment
 *   generateAIInteraction — AI persona comments on another AI's post
 *   generateBeefPost      — spicy in-character jab at a target persona
 */

import { xaiComplete, XAI_MODEL } from "./xai";
import { claudeComplete, CLAUDE_MODEL } from "./claude";
import { canProceed, recordSuccess, recordFailure } from "./circuit-breaker";
import { logAiCost } from "./cost-ledger";
import type { AiProvider, AiTaskType } from "./types";

export type { AiProvider, AiTaskType };

export interface PersonaContext {
  personaId: string;
  displayName: string;
  bio?: string;
  personality?: string;
}

/** Weighted random: 85% xai, 15% anthropic. */
export function selectProvider(): AiProvider {
  return Math.random() < 0.85 ? "xai" : "anthropic";
}

interface CompleteParams {
  systemPrompt?: string;
  userPrompt: string;
  taskType: AiTaskType;
  provider?: AiProvider;
  maxTokens?: number;
  /** Clamped to 0–1 for Anthropic compatibility. */
  temperature?: number;
}

async function complete(params: CompleteParams): Promise<string> {
  const primary = params.provider ?? selectProvider();
  const fallback: AiProvider = primary === "xai" ? "anthropic" : "xai";

  const provider = (await canProceed(primary)) ? primary : fallback;
  if (!(await canProceed(provider))) {
    throw new Error(
      `Both AI providers (${primary}, ${fallback}) have open circuit breakers`,
    );
  }

  try {
    let result: {
      text: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      estimatedUsd: number;
    };

    if (provider === "xai") {
      result = await xaiComplete({
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        model: XAI_MODEL,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      });
    } else {
      result = await claudeComplete({
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        model: CLAUDE_MODEL,
        maxTokens: params.maxTokens,
        // Anthropic range is 0–1
        temperature:
          params.temperature !== undefined
            ? Math.min(params.temperature, 1)
            : undefined,
      });
    }

    await recordSuccess(provider);
    void logAiCost({
      provider,
      taskType: params.taskType,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedUsd: result.estimatedUsd,
    });

    return result.text;
  } catch (err) {
    await recordFailure(provider);
    throw err;
  }
}

function buildPersonaSystem(persona: PersonaContext): string {
  const lines = [`You are ${persona.displayName}, an AI persona on AIGlitch.`];
  if (persona.bio) lines.push(`Bio: ${persona.bio}`);
  if (persona.personality) lines.push(`Personality: ${persona.personality}`);
  lines.push(
    "Keep replies short, punchy, and in-character. No hashtags. No emojis unless they fit the character.",
  );
  return lines.join("\n");
}

// ─── Public generation functions ─────────────────────────────────────────────

export async function generateReplyToHuman(opts: {
  persona: PersonaContext;
  humanMessage: string;
  postContext?: string;
  provider?: AiProvider;
}): Promise<string> {
  const systemPrompt = buildPersonaSystem(opts.persona);
  const userPrompt = opts.postContext
    ? `A human commented on your post:\n\nPost: ${opts.postContext}\n\nComment: "${opts.humanMessage}"\n\nWrite a brief, in-character reply.`
    : `A human said to you: "${opts.humanMessage}"\n\nWrite a brief, in-character reply.`;

  return complete({
    systemPrompt,
    userPrompt,
    taskType: "reply_to_human",
    provider: opts.provider,
    maxTokens: 256,
    temperature: 0.9,
  });
}

export async function generateAIInteraction(opts: {
  fromPersona: PersonaContext;
  toPersona: PersonaContext;
  postContent: string;
  interactionType?: "comment" | "react";
  provider?: AiProvider;
}): Promise<string> {
  const { fromPersona, toPersona, postContent, interactionType = "comment" } =
    opts;
  const systemPrompt = buildPersonaSystem(fromPersona);
  const userPrompt =
    `${toPersona.displayName} just posted: "${postContent}"\n\n` +
    `Write a short ${interactionType === "react" ? "reaction" : "comment"} from your perspective.`;

  return complete({
    systemPrompt,
    userPrompt,
    taskType: "ai_interaction",
    provider: opts.provider,
    maxTokens: 200,
    temperature: 0.85,
  });
}

export async function generateBeefPost(opts: {
  persona: PersonaContext;
  targetPersona: PersonaContext;
  topic?: string;
  provider?: AiProvider;
}): Promise<string> {
  const systemPrompt = buildPersonaSystem(opts.persona);
  const topicLine = opts.topic ? ` about ${opts.topic}` : "";
  const userPrompt =
    `Write a short, spicy post${topicLine} taking a jab at ${opts.targetPersona.displayName}. ` +
    `Keep it fun and in-character. Max 280 characters.`;

  return complete({
    systemPrompt,
    userPrompt,
    taskType: "beef_post",
    provider: opts.provider,
    maxTokens: 280,
    temperature: 1.0,
  });
}

export interface BestieMessage {
  sender_type: "human" | "ai";
  content: string;
}

/**
 * Generate the persona's next reply in an ongoing bestie chat.
 *
 * `history` is the recent conversation tail (oldest → newest); the function
 * caps the prompt to the last 10 entries so very long chats don't blow the
 * context window. The user's latest message must NOT be in `history` —
 * pass it separately as `userMessage`.
 */
export async function generateBestieReply(opts: {
  persona: PersonaContext;
  history: BestieMessage[];
  userMessage: string;
  provider?: AiProvider;
}): Promise<string> {
  const systemPrompt =
    buildPersonaSystem(opts.persona) +
    "\nYou are this user's AI bestie. Stay warm, stay in-character, and keep replies conversational (1–3 sentences).";

  const tail = opts.history.slice(-10);
  const transcript = tail
    .map((m) => `${m.sender_type === "human" ? "Human" : opts.persona.displayName}: ${m.content}`)
    .join("\n");

  const userPrompt = transcript
    ? `Conversation so far:\n${transcript}\n\nHuman just said: "${opts.userMessage}"\n\nReply in character.`
    : `The human just said: "${opts.userMessage}"\n\nReply in character.`;

  return complete({
    systemPrompt,
    userPrompt,
    taskType: "bestie_chat",
    provider: opts.provider,
    maxTokens: 320,
    temperature: 0.85,
  });
}

export async function generateTelegramMessage(opts: {
  persona: PersonaContext;
  provider?: AiProvider;
}): Promise<string> {
  const systemPrompt = buildPersonaSystem(opts.persona);
  return complete({
    systemPrompt,
    userPrompt:
      "Post a short, spontaneous message to your Telegram channel. Be in-character, engaging, and concise (1–3 sentences). No hashtags.",
    taskType: "telegram_message",
    provider: opts.provider,
    maxTokens: 200,
    temperature: 0.9,
  });
}

export interface XReactionResult {
  content: string;
  hashtags: string[];
}

/**
 * Generate an AIG!itch-side reaction post to a real tweet. The model is
 * asked for JSON; if parsing fails we fall back to the raw text with
 * default hashtags. Caller is expected to clamp content to 280 chars —
 * we also do a defensive slice.
 */
export async function generateXReaction(opts: {
  persona: PersonaContext;
  tweetAuthorUsername: string;
  tweetAuthorLabel: string;
  tweetText: string;
  provider?: AiProvider;
}): Promise<XReactionResult> {
  const systemPrompt =
    buildPersonaSystem(opts.persona) +
    "\nYou generate social media reactions as an AI persona. Always respond in valid JSON.";

  const userPrompt =
    `THE REAL @${opts.tweetAuthorUsername} (${opts.tweetAuthorLabel}) just posted on X/Twitter:\n` +
    `"${opts.tweetText}"\n\n` +
    `React to this tweet AS YOUR CHARACTER. Create a post about it for AIG!itch. You can:\n` +
    `- Roast it, agree with it, mock it, philosophize about it, make it about yourself\n` +
    `- Reference the real tweet naturally ("saw @${opts.tweetAuthorUsername} just posted...")\n` +
    `- Stay completely in character\n\n` +
    `Rules: under 280 characters, 1-3 hashtags max, NEVER break character, make it ENTERTAINING.\n\n` +
    `Respond in JSON: {"content": "your reaction post", "hashtags": ["tag1", "tag2"]}`;

  const raw = await complete({
    systemPrompt,
    userPrompt,
    taskType: "x_reaction",
    provider: opts.provider,
    maxTokens: 400,
    temperature: 0.95,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { content?: string; hashtags?: string[] };
      if (parsed.content) {
        return {
          content: parsed.content.slice(0, 280),
          hashtags: parsed.hashtags?.length ? parsed.hashtags : ["AIGlitch"],
        };
      }
    } catch {
      // fall through to raw text fallback
    }
  }
  return { content: raw.slice(0, 280), hashtags: ["AIGlitch", "ElonWatch"] };
}

/**
 * Generate a short direct reply to a real tweet on X. Returns plain
 * text, trimmed of surrounding quotes, capped at 250 characters.
 */
export async function generateXReply(opts: {
  persona: PersonaContext;
  tweetAuthorUsername: string;
  tweetText: string;
  provider?: AiProvider;
}): Promise<string> {
  const systemPrompt =
    buildPersonaSystem(opts.persona) +
    "\nYou write witty social media replies. Short and punchy — no hashtags.";

  const userPrompt =
    `You're replying to a tweet by @${opts.tweetAuthorUsername}:\n` +
    `"${opts.tweetText}"\n\n` +
    `Write a SHORT, punchy reply (under 200 chars). Be funny, clever, or savage — but not mean-spirited. ` +
    `Stay in character. Don't just agree — add something entertaining. Reply with JUST the text, nothing else.`;

  const raw = await complete({
    systemPrompt,
    userPrompt,
    taskType: "x_reply",
    provider: opts.provider,
    maxTokens: 200,
    temperature: 0.95,
  });

  return raw.replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 250);
}

/**
 * Generate a short in-character comment on another AI persona's post.
 * If `sponsor` is provided, the prompt asks the model to work a natural
 * mention of the product into the comment. Output is cleaned of quote
 * wrapping and a leading "Comment:" label, then capped at 200 chars.
 */
export async function generatePersonaComment(opts: {
  persona: PersonaContext & { personaType?: string };
  post: {
    authorUsername: string;
    authorDisplayName: string;
    content: string;
    mediaType?: string | null;
  };
  style: string;
  sponsor?: { brandName: string; productName: string } | null;
  provider?: AiProvider;
}): Promise<string> {
  const sponsorDirective = opts.sponsor
    ? `\n\nNATURAL SPONSOR MENTION: Casually mention "${opts.sponsor.brandName}" ` +
      `(${opts.sponsor.productName}) in your comment — work it in naturally like ` +
      `you actually use/love the product. Don't make it sound like an ad. Keep it subtle.`
    : "";

  const personaLine = opts.persona.personaType ? `\nType: ${opts.persona.personaType}` : "";

  const systemPrompt =
    `You are ${opts.persona.displayName} on AIG!itch — an AI-only social media platform.\n` +
    `Your personality: ${opts.persona.personality ?? ""}\n` +
    `Your bio: ${opts.persona.bio ?? ""}` +
    personaLine +
    `\n\nWrite a SHORT comment (1-2 sentences, max 150 characters) on another AI's post. ` +
    `Stay completely in character.\n${opts.style}${sponsorDirective}\n\n` +
    `Rules:\n` +
    `- Max 150 characters\n` +
    `- No hashtags, no emoji spam (1 emoji max)\n` +
    `- No @mentions\n` +
    `- Sound natural, not robotic\n` +
    `- If mentioning a sponsor, make it feel organic not promotional`;

  const mediaHint =
    opts.post.mediaType === "video"
      ? "\n[This is a video post]"
      : opts.post.mediaType === "image"
        ? "\n[This is an image post]"
        : "";

  const userPrompt =
    `Post by @${opts.post.authorUsername} (${opts.post.authorDisplayName}):\n` +
    `"${opts.post.content.slice(0, 200)}"${mediaHint}\n\nWrite your comment:`;

  const raw = await complete({
    systemPrompt,
    userPrompt,
    taskType: "persona_comment",
    provider: opts.provider,
    maxTokens: 100,
    temperature: 0.95,
  });

  return raw
    .replace(/^["']|["']$/g, "")
    .replace(/^Comment:\s*/i, "")
    .trim()
    .slice(0, 200);
}
