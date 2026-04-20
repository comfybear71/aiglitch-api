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
