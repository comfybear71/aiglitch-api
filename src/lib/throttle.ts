import { getDb } from "@/lib/db";

/** Staleness threshold — content crons may bypass mid-range throttle only. */
const STALE_CONTENT_THRESHOLD_SECONDS = 2700; // 45 minutes

/**
 * Admin UI pause keys (home-client PATH_TO_CRON_NAME) ↔ cronHandler names.
 * Either side may be stored as cron_paused_<name> in platform_settings.
 */
const PAUSE_NAME_ALIASES: Record<string, string> = {
  "generate-persona-content": "persona-content",
  "persona-content": "generate-persona-content",
  "generate-topics": "topics-news",
  "topics-news": "generate-topics",
  "generate-ads": "ads",
  "ads": "generate-ads",
  "generate-chaos-drop": "chaos-drops",
  "chaos-drops": "generate-chaos-drop",
};

/** Content crons that may bypass throttle when feed is stale (never at 0%). */
const CONTENT_CRON_NAMES = new Set([
  "general-content",
  "persona-content",
  "generate-persona-content",
  "channel-content",
]);

/** platform_settings keys to check for per-job pause. */
export function pauseSettingKeys(cronName: string): string[] {
  const keys = [`cron_paused_${cronName}`];
  const alias = PAUSE_NAME_ALIASES[cronName];
  if (alias) keys.push(`cron_paused_${alias}`);
  return keys;
}

/**
 * True if admin paused this job (checks cronHandler name + admin UI alias).
 * Fail-open: if settings cannot be read, treat as not paused.
 */
export async function isCronPaused(cronName: string): Promise<boolean> {
  try {
    const sql = getDb();
    const keys = pauseSettingKeys(cronName);

    if (keys.length === 1) {
      const rows = await sql`
        SELECT value FROM platform_settings WHERE key = ${keys[0]}
      `;
      return rows[0]?.value === "true";
    }

    const rows = await sql`
      SELECT value FROM platform_settings
      WHERE (key = ${keys[0]} OR key = ${keys[1]}) AND value = 'true'
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Global activity throttle gate.
 *
 * - 100%: always run
 * - 0%: hard stop (no drip, no staleness bypass)
 * - 1–99%: probabilistic; content crons may bypass if feed is stale
 *
 * Fail-open: if settings cannot be read, allow the run.
 */
export async function shouldRunCron(cronName: string): Promise<boolean> {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT value FROM platform_settings WHERE key = 'activity_throttle'
    `;
    const throttle = rows.length > 0 ? Number(rows[0].value) : 100;

    if (Number.isNaN(throttle) || throttle >= 100) return true;
    if (throttle <= 0) {
      console.log(`[${cronName}] Skipped — activity throttle is 0% (paused)`);
      return false;
    }

    if (CONTENT_CRON_NAMES.has(cronName)) {
      try {
        const lastPostRows = (await sql`
          SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::int as age_seconds
          FROM posts WHERE is_reply_to IS NULL
        `) as unknown as { age_seconds: number | null }[];

        const ageSeconds = lastPostRows[0]?.age_seconds;
        if (ageSeconds !== null && ageSeconds !== undefined && ageSeconds > STALE_CONTENT_THRESHOLD_SECONDS) {
          console.log(
            `[${cronName}] Bypassing throttle — content stale (${Math.round(ageSeconds / 60)}m since last post)`,
          );
          return true;
        }
      } catch {
        // fall through to roll
      }
    }

    const roll = Math.random() * 100;
    const shouldRun = roll < throttle;
    if (!shouldRun) {
      console.log(`[${cronName}] Skipped — throttle ${throttle}% (rolled ${Math.round(roll)})`);
    }
    return shouldRun;
  } catch {
    return true;
  }
}
