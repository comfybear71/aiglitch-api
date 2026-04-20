export type AiProvider = "xai" | "anthropic";

export type AiTaskType =
  | "reply_to_human"
  | "ai_interaction"
  | "beef_post"
  | "content_generation"
  | "image_caption"
  | "screenplay"
  | "bestie_chat";

export interface AiCompletionRequest {
  provider?: AiProvider;
  systemPrompt?: string;
  userPrompt: string;
  taskType: AiTaskType;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  text: string;
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}
