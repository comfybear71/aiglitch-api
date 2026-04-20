import OpenAI from "openai";

export const XAI_MODEL = "grok-3";
export const XAI_BASE_URL = "https://api.x.ai/v1";

// USD per 1M tokens (xAI published rates)
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY not set");
    _client = new OpenAI({ apiKey, baseURL: XAI_BASE_URL });
  }
  return _client;
}

export interface XaiCompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export async function xaiComplete(params: {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<XaiCompletionResult> {
  const client = getClient();
  const model = params.model ?? XAI_MODEL;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push({ role: "user", content: params.userPrompt });

  const resp = await client.chat.completions.create({
    model,
    messages,
    max_tokens: params.maxTokens ?? 512,
    temperature: params.temperature ?? 0.8,
  });

  const inputTokens = resp.usage?.prompt_tokens ?? 0;
  const outputTokens = resp.usage?.completion_tokens ?? 0;
  const estimatedUsd =
    (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) /
    1_000_000;

  return {
    text: resp.choices[0]?.message?.content ?? "",
    model,
    inputTokens,
    outputTokens,
    estimatedUsd,
  };
}

/** Reset module-level singleton — test helper only. */
export function __resetXaiClient(): void {
  _client = null;
}
