/**
 * /api/activity-throttle — admin UI controls for cron throttling.
 *
 * Two storage rows in `platform_settings`:
 *   - `activity_throttle` (0-100) — global cap
 *   - `cron_paused_<job_name>` ("true" | "false") — per-job pause
 *
 * Ported from legacy aiglitch. Replaces the earlier aiglitch-api
 * version which used a separate `cron_throttle` table that the admin
 * UI doesn't understand — the UI is built against this legacy shape,
 * so the legacy contract wins.
 *
 * `ensureDbReady` dropped per CLAUDE.md migration rule #4.
 *
 * Auth: GET is unauthenticated (read-only stats the dashboard polls
 * every few seconds; matches legacy). POST requires the admin cookie.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sql = getDb();

  let throttle = 100;
  try {
    const rows = (await sql`
      SELECT value FROM platform_settings WHERE key = 'activity_throttle'
    `) as Array<{ value: string }>;
    if (rows.length > 0) throttle = Number(rows[0].value);
  } catch (err) {
    console.error("[activity-throttle GET] throttle read failed:", err);
  }

  const action = request.nextUrl.searchParams.get("action");
  if (action === "job_states") {
    const states: Record<string, boolean> = {};
    try {
      const pausedRows = (await sql`
        SELECT key, value FROM platform_settings WHERE key LIKE 'cron_paused_%'
      `) as Array<{ key: string; value: string }>;
      for (const row of pausedRows) {
        const jobName = row.key.replace("cron_paused_", "");
        states[jobName] = row.value === "true";
      }
    } catch (err) {
      console.error("[activity-throttle GET] job_states read failed:", err);
    }
    return NextResponse.json({ throttle, jobStates: states });
  }

  return NextResponse.json({ throttle });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sql = getDb();

  // Per-job pause/resume.
  if (body.action === "toggle_job") {
    const jobName = body.job_name as string | undefined;
    if (!jobName) {
      return NextResponse.json({ error: "Missing job_name" }, { status: 400 });
    }

    const key = `cron_paused_${jobName}`;
    let newValue = "true";
    try {
      const rows = (await sql`SELECT value FROM platform_settings WHERE key = ${key}`) as Array<{
        value: string;
      }>;
      const current = rows[0]?.value;
      newValue = current === "true" ? "false" : "true";

      await sql`
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES (${key}, ${newValue}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${newValue}, updated_at = NOW()
      `;
    } catch (err) {
      console.error("[activity-throttle POST] toggle_job failed:", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Toggle failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ job: jobName, paused: newValue === "true" });
  }

  // Global throttle (clamped 0-100).
  const throttle = Math.min(
    100,
    Math.max(0, Math.round(Number(body.throttle) || 0)),
  );

  try {
    await sql`
      INSERT INTO platform_settings (key, value, updated_at)
      VALUES ('activity_throttle', ${String(throttle)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${String(throttle)}, updated_at = NOW()
    `;
  } catch (err) {
    console.error("[activity-throttle POST] throttle write failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Throttle write failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ throttle });
}
