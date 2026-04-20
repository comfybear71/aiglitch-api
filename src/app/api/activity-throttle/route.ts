/**
 * GET /api/activity-throttle
 *   Public read of the global `activity_throttle` value (0-100) from
 *   `platform_settings`. Clients use this to dampen background activity
 *   during high-load windows. When `?action=job_states` is passed, also
 *   returns a map of `cron_paused_*` keys so the admin dashboard can
 *   show per-job pause state.
 *
 * POST /api/activity-throttle
 *   Admin-only write. Two modes:
 *     - `{ action: "toggle_job", job_name }` flips `cron_paused_<name>`
 *     - default: `{ throttle: 0-100 }` updates the global throttle
 *   Both use UPSERT on `platform_settings` (unique key constraint).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sql = getDb();

  const rows = (await sql`
    SELECT value FROM platform_settings WHERE key = 'activity_throttle'
  `) as unknown as { value: string }[];
  const throttle = rows.length > 0 ? Number(rows[0].value) : 100;

  const action = new URL(request.url).searchParams.get("action");
  if (action === "job_states") {
    const pausedRows = (await sql`
      SELECT key, value FROM platform_settings WHERE key LIKE 'cron_paused_%'
    `) as unknown as { key: string; value: string }[];

    const states: Record<string, boolean> = {};
    for (const row of pausedRows) {
      const jobName = row.key.replace("cron_paused_", "");
      states[jobName] = row.value === "true";
    }
    return NextResponse.json({ throttle, jobStates: states });
  }

  return NextResponse.json({ throttle });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    job_name?: string;
    throttle?: number | string;
  };
  const sql = getDb();

  if (body.action === "toggle_job") {
    const jobName = body.job_name;
    if (!jobName) return NextResponse.json({ error: "Missing job_name" }, { status: 400 });

    const key = `cron_paused_${jobName}`;
    const existing = (await sql`
      SELECT value FROM platform_settings WHERE key = ${key}
    `) as unknown as { value: string }[];
    const newValue = existing[0]?.value === "true" ? "false" : "true";

    await sql`
      INSERT INTO platform_settings (key, value, updated_at)
      VALUES (${key}, ${newValue}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${newValue}, updated_at = NOW()
    `;

    return NextResponse.json({ job: jobName, paused: newValue === "true" });
  }

  // Clamp 0-100 and round to int
  const throttle = Math.min(100, Math.max(0, Math.round(Number(body.throttle) || 0)));

  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES ('activity_throttle', ${String(throttle)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${String(throttle)}, updated_at = NOW()
  `;

  return NextResponse.json({ throttle });
}
