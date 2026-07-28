/**
 * Per-cron soft interval overrides.
 *
 * Vercel still fires on vercel.json schedules. Admins can stretch how often
 * a job *actually* runs by storing minutes in platform_settings:
 *   cron_interval_minutes_<jobName>
 *
 * cronHandler skips (status throttled, reason interval) when the last
 * successful (status=ok) run is newer than the configured minutes.
 */

import { getDb } from "@/lib/db";

/** Same aliases as pause keys so UI job names and cronHandler names both work. */
const INTERVAL_NAME_ALIASES: Record<string, string> = {
  "generate-persona-content": "persona-content",
  "persona-content": "generate-persona-content",
  "generate-topics": "topics-news",
  "topics-news": "generate-topics",
  "generate-ads": "ads",
  ads: "generate-ads",
  "generate-chaos-drop": "chaos-drops",
  "chaos-drops": "generate-chaos-drop",
};

/** Defaults match Overview cronSchedules / vercel cadence (minutes). */
export const DEFAULT_CRON_INTERVALS_MIN: Record<string, number> = {
  "generate-persona-content": 40,
  "persona-content": 40,
  "general-content": 30,
  "marketing-post": 240,
  "ai-trading": 30,
  "budju-trading": 30,
  "avatar-gen": 120,
  "generate-topics": 120,
  "topics-news": 120,
  "generate-ads": 240,
  ads: 240,
  "generate-chaos-drop": 120,
  "chaos-drops": 120,
  "x-react": 30,
  "telegram-persona-message": 180,
};

/** Presets offered in the admin UI (minutes). */
export const CRON_INTERVAL_PRESETS = [
  30, 40, 60, 120, 180, 240, 360, 720, 1440,
] as const;

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 10080; // 7 days

export function intervalSettingKeys(cronName: string): string[] {
  const keys = [`cron_interval_minutes_${cronName}`];
  const alias = INTERVAL_NAME_ALIASES[cronName];
  if (alias) keys.push(`cron_interval_minutes_${alias}`);
  return keys;
}

export function clampCronIntervalMinutes(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(raw)));
}

export function defaultIntervalMinutes(cronName: string): number | null {
  return DEFAULT_CRON_INTERVALS_MIN[cronName] ?? null;
}

/**
 * Effective soft-interval for a job (override or default).
 * Returns null if this job has no known default and no override.
 */
export async function getCronIntervalMinutes(
  cronName: string,
): Promise<number | null> {
  const override = await getCronIntervalOverride(cronName);
  if (override != null) return override;
  return defaultIntervalMinutes(cronName);
}

/** Admin override only — null means “use vercel.json cadence, no soft gate”. */
export async function getCronIntervalOverride(
  cronName: string,
): Promise<number | null> {
  try {
    const sql = getDb();
    const keys = intervalSettingKeys(cronName);

    let rows: Array<{ value: string }> = [];
    if (keys.length === 1) {
      rows = (await sql`
        SELECT value FROM platform_settings WHERE key = ${keys[0]} LIMIT 1
      `) as Array<{ value: string }>;
    } else {
      rows = (await sql`
        SELECT value FROM platform_settings
        WHERE key = ${keys[0]} OR key = ${keys[1]}
        LIMIT 1
      `) as Array<{ value: string }>;
    }

    if (rows[0]?.value) {
      const n = Number(rows[0].value);
      if (Number.isFinite(n) && n > 0) return clampCronIntervalMinutes(n);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Load all cron_interval_minutes_* overrides as jobName → minutes. */
export async function loadCronIntervalOverrides(): Promise<
  Record<string, number>
> {
  const out: Record<string, number> = {};
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT key, value FROM platform_settings
      WHERE key LIKE 'cron_interval_minutes_%'
    `) as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const job = row.key.replace("cron_interval_minutes_", "");
      const n = Number(row.value);
      if (job && Number.isFinite(n) && n > 0) {
        out[job] = clampCronIntervalMinutes(n);
      }
    }
  } catch {
    /* empty */
  }
  return out;
}

/**
 * True when enough time has passed since the last successful (ok) run.
 * No admin override → always allow (Vercel schedule wins).
 * Fail-open: if we cannot read, allow the run.
 */
export async function shouldRunByInterval(cronName: string): Promise<boolean> {
  // Route tests queue exact SQL results for cronHandler. Soft-interval has its
  // own unit tests (set TEST_CRON_INTERVAL=1 to exercise this path in Vitest).
  if (process.env.VITEST === "true" && process.env.TEST_CRON_INTERVAL !== "1") {
    return true;
  }

  try {
    const intervalMin = await getCronIntervalOverride(cronName);
    if (intervalMin == null) return true;

    const sql = getDb();
    const names = [cronName];
    const alias = INTERVAL_NAME_ALIASES[cronName];
    if (alias) names.push(alias);

    const rows = (await sql`
      SELECT started_at
      FROM cron_runs
      WHERE cron_name = ANY(${names}::text[])
        AND status = 'ok'
      ORDER BY started_at DESC
      LIMIT 1
    `) as Array<{ started_at: string }>;

    const last = rows[0]?.started_at;
    if (!last) return true;

    const elapsedMs = Date.now() - new Date(last).getTime();
    const needMs = intervalMin * 60 * 1000;
    if (elapsedMs < needMs) {
      console.log(
        `[${cronName}] Skipped — interval ${intervalMin}m (last ok ${Math.round(elapsedMs / 60000)}m ago)`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${cronName}] interval check failed (allowing run):`, err);
    return true;
  }
}

export async function setCronIntervalMinutes(
  jobName: string,
  minutes: number,
): Promise<number> {
  const clamped = clampCronIntervalMinutes(minutes);
  const sql = getDb();
  const key = `cron_interval_minutes_${jobName}`;
  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${key}, ${String(clamped)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${String(clamped)}, updated_at = NOW()
  `;
  return clamped;
}

/** Resolve display interval for an Overview schedule path/name. */
export function resolveDisplayInterval(
  cronHandlerName: string,
  defaultsMin: number,
  overrides: Record<string, number>,
): number {
  if (overrides[cronHandlerName] != null) return overrides[cronHandlerName]!;
  const alias = INTERVAL_NAME_ALIASES[cronHandlerName];
  if (alias && overrides[alias] != null) return overrides[alias]!;
  return defaultsMin;
}
