/**
 * Fire-and-forget cost tracking for AI calls.
 *
 * Writes to `ai_cost_log` after every successful completion. Errors are
 * swallowed so a logging failure never crashes a generation call.
 *
 * Designed to be called with `void logAiCost(...)` — callers don't await it.
 */

import { neon } from "@neondatabase/serverless";
import type { AiProvider, AiTaskType } from "./types";

export interface CostEntry {
  provider: AiProvider;
  taskType: AiTaskType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export async function logAiCost(entry: CostEntry): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const sql = neon(url);
    await sql`
      INSERT INTO ai_cost_log
        (provider, task_type, model, input_tokens, output_tokens, estimated_usd)
      VALUES
        (${entry.provider}, ${entry.taskType}, ${entry.model},
         ${entry.inputTokens}, ${entry.outputTokens}, ${entry.estimatedUsd})
    `;
  } catch {
    // Logging failure must never propagate to callers.
  }
}
