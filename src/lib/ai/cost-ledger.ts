/**
 * Fire-and-forget cost tracking for AI calls + read helpers for the
 * admin cost dashboard.
 *
 * `logAiCost` writes to `ai_cost_log` after every successful completion.
 * Errors are swallowed so a logging failure never crashes a generation
 * call — designed to be called with `void logAiCost(...)`.
 *
 * The read helpers (`getCostHistory`, `getDailySpendTotals`, etc.) are
 * all defensive: missing table / unset DATABASE_URL returns an empty
 * shape rather than throwing. Column names (`task_type`, `estimated_usd`)
 * match our schema — NOT the legacy schema (`task`, `estimated_cost_usd`).
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { AiProvider, AiTaskType } from "./types";

type Sql = NeonQueryFunction<false, false>;

export interface CostEntry {
  provider: AiProvider;
  taskType: AiTaskType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

function sqlClient(): Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

export async function logAiCost(entry: CostEntry): Promise<void> {
  const sql = sqlClient();
  if (!sql) return;
  try {
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

// ── Read helpers for /api/admin/costs + /api/admin/stats ────────────────

export interface LifetimeTotals {
  totalUsd: number;
  totalCalls: number;
}

export interface HistoryRow {
  date: string;
  provider: string;
  task_type: string;
  total_usd: number;
  count: number;
}

export interface DailyTotal {
  date: string;
  total_usd: number;
  count: number;
}

export interface ProviderTotal {
  provider: string;
  total_usd: number;
  count: number;
}

export interface TopTask {
  task_type: string;
  provider: string;
  total_usd: number;
  count: number;
}

/** Lifetime spend + call count. Returns zeros on any query error. */
export async function getLifetimeTotals(): Promise<LifetimeTotals> {
  const sql = sqlClient();
  if (!sql) return { totalUsd: 0, totalCalls: 0 };
  try {
    const rows = (await sql`
      SELECT
        COALESCE(ROUND(SUM(estimated_usd)::numeric, 4), 0) AS total_usd,
        COALESCE(COUNT(*)::int, 0)                         AS total_calls
      FROM ai_cost_log
    `) as unknown as { total_usd: string | number; total_calls: number }[];
    const row = rows[0];
    return {
      totalUsd: Number(row?.total_usd ?? 0),
      totalCalls: Number(row?.total_calls ?? 0),
    };
  } catch {
    return { totalUsd: 0, totalCalls: 0 };
  }
}

/** Per-day + provider + task_type aggregates for the last N days. */
export async function getCostHistory(days = 7): Promise<HistoryRow[]> {
  const sql = sqlClient();
  if (!sql) return [];
  try {
    return (await sql`
      SELECT
        DATE(created_at)                      AS date,
        provider,
        task_type,
        ROUND(SUM(estimated_usd)::numeric, 4) AS total_usd,
        COUNT(*)::int                         AS count
      FROM ai_cost_log
      WHERE created_at > NOW() - INTERVAL '1 day' * ${days}
      GROUP BY DATE(created_at), provider, task_type
      ORDER BY date DESC, total_usd DESC
    `) as unknown as HistoryRow[];
  } catch {
    return [];
  }
}

/** Simple per-day spend totals for chart visualisation. */
export async function getDailySpendTotals(days = 7): Promise<DailyTotal[]> {
  const sql = sqlClient();
  if (!sql) return [];
  try {
    return (await sql`
      SELECT
        DATE(created_at)                      AS date,
        ROUND(SUM(estimated_usd)::numeric, 4) AS total_usd,
        COUNT(*)::int                         AS count
      FROM ai_cost_log
      WHERE created_at > NOW() - INTERVAL '1 day' * ${days}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `) as unknown as DailyTotal[];
  } catch {
    return [];
  }
}

/** Top N most expensive (task_type, provider) pairs over the last N days. */
export async function getTopTasksByCost(days = 7, limit = 5): Promise<TopTask[]> {
  const sql = sqlClient();
  if (!sql) return [];
  try {
    return (await sql`
      SELECT
        task_type,
        provider,
        ROUND(SUM(estimated_usd)::numeric, 4) AS total_usd,
        COUNT(*)::int                         AS count
      FROM ai_cost_log
      WHERE created_at > NOW() - INTERVAL '1 day' * ${days}
      GROUP BY task_type, provider
      ORDER BY total_usd DESC
      LIMIT ${limit}
    `) as unknown as TopTask[];
  } catch {
    return [];
  }
}

/** Per-provider lifetime totals (no date filter). */
export async function getProviderTotals(): Promise<ProviderTotal[]> {
  const sql = sqlClient();
  if (!sql) return [];
  try {
    return (await sql`
      SELECT
        provider,
        ROUND(SUM(estimated_usd)::numeric, 4) AS total_usd,
        COUNT(*)::int                         AS count
      FROM ai_cost_log
      GROUP BY provider
      ORDER BY total_usd DESC
    `) as unknown as ProviderTotal[];
  } catch {
    return [];
  }
}
