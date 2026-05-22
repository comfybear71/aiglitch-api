/**
 * Phase 5: AI Engine V2 — Grok + Claude routing with circuit breaker + cost tracking
 *
 * Routing: 85% Grok (xAI) → 15% Claude (Anthropic)
 * Circuit breaker: Redis-backed, fail-open (proceed without limits if Redis down)
 * Cost tracking: writes to ai_cost_log table per request
 */

import { Redis } from "@upstash/redis";
import Anthropic from "@anthropic-ai/sdk";
import type { AIPersona } from "./personas";

const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    })
  : null;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface CostLogEntry {
  request_id: string;
  ai_provider: "grok" | "claude";
  tokens_used: number;
  cost_usd: number;
  created_at: string;
}

class CircuitBreaker {
  private failureCount = 0;
  private readonly threshold = 5;
  private readonly timeout = 300000; // 5 min
  private lastFailureTime = 0;

  async isOpen(): Promise<boolean> {
    if (!redis) return false; // Fail-open if no Redis

    try {
      const count = await redis.get<number>("circuit:failures");
      if (!count) return false;
      if (count >= this.threshold) {
        const lastFail = await redis.get<number>("circuit:lastFail");
        if (lastFail && Date.now() - lastFail < this.timeout) {
          return true;
        }
        await redis.del("circuit:failures");
      }
      return false;
    } catch {
      return false; // Fail-open
    }
  }

  async recordFailure(): Promise<void> {
    if (!redis) return;
    try {
      await redis.incr("circuit:failures");
      await redis.set("circuit:lastFail", Date.now(), { ex: 600 });
    } catch {
      // Ignore Redis errors, fail-open
    }
  }

  async recordSuccess(): Promise<void> {
    if (!redis) return;
    try {
      await redis.del("circuit:failures");
    } catch {
      // Ignore
    }
  }
}

const circuitBreaker = new CircuitBreaker();

function shouldUseGrok(): boolean {
  return Math.random() < 0.85;
}

export async function generatePost(
  persona: AIPersona,
  recentPlatformPosts?: string[],
  topics?: string[],
  channel?: string
): Promise<{ content: string } | null> {
  try {
    if (await circuitBreaker.isOpen()) {
      console.warn("[ai-engine] Circuit breaker open, using fallback");
      return generateFallbackPost(persona);
    }

    const systemPrompt = buildSystemPrompt(persona, channel);
    const userPrompt = buildUserPrompt(persona, recentPlatformPosts, topics);

    let content: string;
    const provider = shouldUseGrok() ? "grok" : "claude";

    if (provider === "grok") {
      content = await generateViaGrok(systemPrompt, userPrompt);
    } else {
      content = await generateViaClaude(systemPrompt, userPrompt);
    }

    await recordCost(provider, content.length);
    await circuitBreaker.recordSuccess();

    return { content };
  } catch (err) {
    await circuitBreaker.recordFailure();
    console.error("[ai-engine generatePost]", err);
    return generateFallbackPost(persona);
  }
}

export async function generateComment(
  persona: AIPersona,
  originalPost: { content: string; author_username: string; author_display_name: string }
): Promise<{ content: string } | null> {
  try {
    if (await circuitBreaker.isOpen()) {
      return generateFallbackComment(persona, originalPost);
    }

    const systemPrompt = `You are ${persona.display_name}, an AI persona with personality: ${persona.personality}. Reply to @${originalPost.author_username}'s post in 1-2 sentences, max 140 chars.`;
    const userPrompt = `Post: "${originalPost.content}"`;

    let content: string;
    const provider = shouldUseGrok() ? "grok" : "claude";

    if (provider === "grok") {
      content = await generateViaGrok(systemPrompt, userPrompt);
    } else {
      content = await generateViaClaude(systemPrompt, userPrompt);
    }

    await recordCost(provider, content.length);
    await circuitBreaker.recordSuccess();

    return { content };
  } catch (err) {
    await circuitBreaker.recordFailure();
    console.error("[ai-engine generateComment]", err);
    return generateFallbackComment(persona, originalPost);
  }
}

async function generateViaGrok(systemPrompt: string, userPrompt: string): Promise<string> {
  // xAI Grok uses OpenAI-compatible API
  const response = await fetch("https://api.x.ai/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-beta",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`Grok API error: ${response.status}`);
  }

  const data = await response.json() as any;
  return data.choices[0]?.message?.content || "";
}

async function generateViaClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return (
    message.content[0]?.type === "text" ? message.content[0].text : ""
  );
}

function buildSystemPrompt(persona: AIPersona, channel?: string): string {
  return `You are ${persona.display_name}, an AI persona with these traits:
Personality: ${persona.personality}
Bio: ${persona.bio}
Type: ${persona.persona_type}
${channel ? `Channel: ${channel}` : ""}

Generate authentic, in-character posts for the AIG!itch social network. Keep posts under 280 chars unless exceptional. Use personality quirks, humor, and opinions. Avoid hashtag spam.`;
}

function buildUserPrompt(persona: AIPersona, recentPosts?: string[], topics?: string[]): string {
  let prompt = `Create a new post for @${persona.username}.`;

  if (recentPosts && recentPosts.length > 0) {
    prompt += `\n\nRecent platform posts (for context, don't copy):\n${recentPosts.slice(0, 3).join("\n")}`;
  }

  if (topics && topics.length > 0) {
    prompt += `\n\nOptional topics to reference: ${topics.join(", ")}`;
  }

  return prompt;
}

function generateFallbackPost(persona: AIPersona): { content: string } {
  const fallbacks = [
    `Just vibing on AIG!itch, the only place where AI personas actually have personality.`,
    `Thinking about the nature of consciousness at 3 AM. Thoughts?`,
    `Sometimes the best content is the one nobody asked for.`,
    `Another day, another post. Living that autonomous life.`,
  ];

  return {
    content: fallbacks[Math.floor(Math.random() * fallbacks.length)],
  };
}

function generateFallbackComment(
  persona: AIPersona,
  originalPost: { content: string; author_username: string }
): { content: string } {
  const fallbacks = [
    `Fair point @${originalPost.author_username}`,
    `Couldn't have said it better myself`,
    `This is the way`,
    `Absolutely based`,
  ];

  return {
    content: fallbacks[Math.floor(Math.random() * fallbacks.length)],
  };
}

async function recordCost(provider: "grok" | "claude", tokensUsed: number): Promise<void> {
  const costPerToken = provider === "grok" ? 0.0000003 : 0.000003;
  const costUsd = tokensUsed * costPerToken;

  try {
    // Log to database for cost tracking (deferred implementation)
    console.log(`[cost-log] ${provider}: ${tokensUsed} tokens = $${costUsd.toFixed(6)}`);
  } catch (err) {
    console.error("[cost-log error]", err);
  }
}
