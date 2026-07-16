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
 * Gate (before fn runs):
 * 1. Per-job pause — platform_settings cron_paused_<name> (+ admin UI aliases)
 * 2. Global activity_throttle — 0% hard-stops all gated crons
 *
 * Skipped runs are logged with status='throttled' and return
 * { skipped: true, reason, cron } without calling fn (no AI spend).
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { isCronPaused, shouldRunCron } from "@/lib/throttle";

export interface CronResult {
  [key: string]: unknown;
}

/** Shape returned when pause or activity throttle skips the job (fn is not called). */
export interface CronSkipResult extends CronResult {
  ok: true;
  skipped: true;
  reason: "paused" | "throttled";
  cron: string;
}

export interface CronHandlerOptions {
  /** Skip pause + activity throttle (rare; prefer admin POST that bypasses cronHandler). */
  skipThrottle?: boolean;
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

async function logSkippedRun(
  id: string,
  name: string,
  reason: "paused" | "throttled",
): Promise<void> {
  const sql = getDb();
  const result = JSON.stringify({ ok: true, skipped: true, reason, cron: name });
  await sql`
    INSERT INTO cron_runs (id, cron_name, status, started_at, finished_at, duration_ms, result)
    VALUES (${id}, ${name}, 'throttled', NOW(), NOW(), 0, ${result}::jsonb)
  `;
}

export async function cronHandler<T extends CronResult>(
  name: string,
  fn: () => Promise<T>,
  options: CronHandlerOptions = {},
): Promise<T & { _cron_run_id: string }> {
  await ensureCronRunsTable();

  const sql = getDb();
  const id = randomUUID();
  const startMs = Date.now();

  if (!options.skipThrottle) {
    if (await isCronPaused(name)) {
      await logSkippedRun(id, name, "paused");
      const skipped: CronSkipResult & { _cron_run_id: string } = {
        ok: true,
        skipped: true,
        reason: "paused",
        cron: name,
        _cron_run_id: id,
      };
      // Skip payload is not T; callers should check `skipped` before reading job fields.
      return skipped as unknown as T & { _cron_run_id: string };
    }

    if (!(await shouldRunCron(name))) {
      await logSkippedRun(id, name, "throttled");
      const skipped: CronSkipResult & { _cron_run_id: string } = {
        ok: true,
        skipped: true,
        reason: "throttled",
        cron: name,
        _cron_run_id: id,
      };
      return skipped as unknown as T & { _cron_run_id: string };
    }
  }

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
