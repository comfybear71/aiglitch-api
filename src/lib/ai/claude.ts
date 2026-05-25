import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-opus-4-7";

// USD per 1M tokens (Anthropic published rates)
const INPUT_COST_PER_M = 15.0;
const OUTPUT_COST_PER_M = 75.0;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface ClaudeCompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export async function claudeComplete(params: {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<ClaudeCompletionResult> {
  const client = getClient();
  const model = params.model ?? CLAUDE_MODEL;

  const resp = await client.messages.create({
    model,
    system: params.systemPrompt,
    messages: [{ role: "user", content: params.userPrompt }],
    max_tokens: params.maxTokens ?? 512,
  });

  const inputTokens = resp.usage.input_tokens;
  const outputTokens = resp.usage.output_tokens;
  const estimatedUsd =
    (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) /
    1_000_000;

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text) {
    console.warn(`[claude] Empty response - content blocks: ${JSON.stringify(resp.content)}, usage: ${inputTokens}/${outputTokens}`);
  }

  return { text, model, inputTokens, outputTokens, estimatedUsd };
}

/** Reset module-level singleton — test helper only. */
export function __resetClaudeClient(): void {
  _client = null;
}

/**
 * Generate a JSON response from Claude — wrapper that extracts the
 * first `{...}` or `[...]` block from the model's text and parses it.
 * Returns null on any failure (no model output, no JSON found, parse
 * error) so callers can fall back to a default without try/catch.
 *
 * Ports the legacy `claude.generateJSON` helper. Kept here rather than
 * forcing every consumer to repeat the regex-extract pattern.
 */
export async function generateJSON<T = unknown>(
  prompt: string,
  maxTokens: number = 1500,
  model: string = CLAUDE_MODEL,
): Promise<T | null> {
  try {
    const { text } = await claudeComplete({
      userPrompt: prompt,
      model,
      maxTokens,
    });
    if (!text) return null;
    const match = text.match(/[\[{][\s\S]*[\]}]/);
    if (!match) return null;
    return JSON.parse(match[0]) as T;
  } catch (err) {
    console.error("[ai/claude] generateJSON failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
