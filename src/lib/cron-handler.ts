/**
 * Cron job execution wrapper.
 *
 * `cronHandler(name, fn)` wraps a cron task so every run is logged to
 * the `cron_runs` table: started_at, finished_at, duration_ms, status,
 * result (JSONB), error. The table is created on first use via
 * CREATE TABLE IF NOT EXISTS — safe to call concurrently, idempotent.
 *
 * On error the row is updated with status='error' and the raw error
 * message, then the error is re-thrown so the caller can return a 500.
 *
 * Pausability: handlers check `platform_settings` themselves if needed.
 * The wrapper does not gate on cron_paused_* — keep it simple.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface CronResult {
  [key: string]: unknown;
}

let cronTableEnsured = false;

async function ensureCronRunsTable(): Promise<void> {
  if (cronTableEnsured) return;
  cronTableEnsured = true;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS cron_runs (
      id           TEXT        PRIMARY KEY,
      cron_name    TEXT        NOT NULL,
      status       TEXT        NOT NULL,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at  TIMESTAMPTZ,
      duration_ms  INTEGER,
      cost_usd     NUMERIC(10,6),
      result       JSONB,
      error        TEXT
    )
  `;
}

/** Reset flag between tests. Do not call in production code. */
export function __resetCronTableFlag(): void {
  cronTableEnsured = false;
}

export async function cronHandler<T extends CronResult>(
  name: string,
  fn: () => Promise<T>,
): Promise<T & { _cron_run_id: string }> {
  await ensureCronRunsTable();

  const sql = getDb();
  const id = randomUUID();
  const startMs = Date.now();

  await sql`
    INSERT INTO cron_runs (id, cron_name, status, started_at)
    VALUES (${id}, ${name}, 'running', NOW())
  `;

  try {
    const result = await fn();
    const durationMs = Date.now() - startMs;

    await sql`
      UPDATE cron_runs
      SET status      = 'ok',
          finished_at = NOW(),
          duration_ms = ${durationMs},
          result      = ${JSON.stringify(result)}::jsonb
      WHERE id = ${id}
    `;

    return { ...result, _cron_run_id: id };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await sql`
      UPDATE cron_runs
      SET status      = 'error',
          finished_at = NOW(),
          duration_ms = ${durationMs},
          error       = ${errorMsg}
      WHERE id = ${id}
    `;

    throw err;
  }
}
