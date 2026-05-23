/**
 * Cron + marketing posting health snapshot.
 *
 * Read-only aggregation used by `/status` (HTML dashboard) and
 * `/api/status` (JSON). Surfaces the failure modes the audit caught:
 *   - Cron-handler errors (cron_runs.status = 'error')
 *   - Marketing post failures (marketing_posts.status = 'failed')
 *   - Silent X media-upload fallbacks (marketing_posts.status = 'posted'
 *     with an error_message — populated by the postToX visibility path)
 *
 * Every query is wrapped in a try/catch returning the safe-empty value
 * so a missing table never takes the dashboard down.
 */

import { getDb } from "@/lib/db";

export interface CronRunSummary {
  cron_name: string;
  status: string;
  error: string | null;
  started_at: string;
  duration_ms: number | null;
}

export interface CronHealth {
  active_count: number;
  total_runs: number;
  errors_24h: number;
  recent_errors: CronRunSummary[];
  recent_runs: CronRunSummary[];
  marketing: {
    failed_24h: number;
    silent_media_failures_24h: number;
    recent_marketing_errors: Array<{
      platform: string;
      status: string;
      error_message: string;
      created_at: string;
    }>;
  };
}

const ACTIVE_CRON_COUNT = 20; // Matches the vercel.json `crons` array length.

async function safeCount(
  fn: () => Promise<unknown[]>,
  key: string,
): Promise<number> {
  try {
    const rows = (await fn()) as Array<Record<string, unknown>>;
    const value = rows[0]?.[key];
    return typeof value === "number" ? value : Number(value ?? 0);
  } catch {
    return 0;
  }
}

async function safeQuery<T>(fn: () => Promise<unknown[]>): Promise<T[]> {
  try {
    return (await fn()) as T[];
  } catch {
    return [];
  }
}

export async function getCronHealth(): Promise<CronHealth> {
  const sql = getDb();

  const [totalRuns, errors24h, recentErrors, recentRuns, marketingFailed24h, silentMediaFailures, recentMarketingErrors] =
    await Promise.all([
      safeCount(
        () => sql`SELECT COUNT(*)::int AS c FROM cron_runs` as unknown as Promise<unknown[]>,
        "c",
      ),
      safeCount(
        () => sql`
          SELECT COUNT(*)::int AS c FROM cron_runs
          WHERE status IN ('error', 'failed')
            AND started_at > NOW() - INTERVAL '24 hours'
        ` as unknown as Promise<unknown[]>,
        "c",
      ),
      safeQuery<CronRunSummary>(
        () => sql`
          SELECT cron_name, status, error, started_at, duration_ms
          FROM cron_runs
          WHERE status IN ('error', 'failed')
          ORDER BY started_at DESC
          LIMIT 5
        ` as unknown as Promise<unknown[]>,
      ),
      safeQuery<CronRunSummary>(
        () => sql`
          SELECT cron_name, status, error, started_at, duration_ms
          FROM cron_runs
          ORDER BY started_at DESC
          LIMIT 10
        ` as unknown as Promise<unknown[]>,
      ),
      safeCount(
        () => sql`
          SELECT COUNT(*)::int AS c FROM marketing_posts
          WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'
        ` as unknown as Promise<unknown[]>,
        "c",
      ),
      safeCount(
        () => sql`
          SELECT COUNT(*)::int AS c FROM marketing_posts
          WHERE status = 'posted'
            AND error_message IS NOT NULL
            AND created_at > NOW() - INTERVAL '24 hours'
        ` as unknown as Promise<unknown[]>,
        "c",
      ),
      safeQuery<{
        platform: string;
        status: string;
        error_message: string;
        created_at: string;
      }>(
        () => sql`
          SELECT platform, status, error_message, created_at
          FROM marketing_posts
          WHERE (status = 'failed' OR error_message IS NOT NULL)
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 10
        ` as unknown as Promise<unknown[]>,
      ),
    ]);

  return {
    active_count: ACTIVE_CRON_COUNT,
    total_runs: totalRuns,
    errors_24h: errors24h,
    recent_errors: recentErrors,
    recent_runs: recentRuns,
    marketing: {
      failed_24h: marketingFailed24h,
      silent_media_failures_24h: silentMediaFailures,
      recent_marketing_errors: recentMarketingErrors,
    },
  };
}
