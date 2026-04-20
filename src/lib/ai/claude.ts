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
    temperature: params.temperature ?? 0.8,
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

  return { text, model, inputTokens, outputTokens, estimatedUsd };
}

/** Reset module-level singleton — test helper only. */
export function __resetClaudeClient(): void {
  _client = null;
}
