/**
 * GET  /api/admin/x-dm?limit=N  — recent DM log rows + rollup stats.
 *   Ensures the `x_dm_logs` table exists first (same CREATE TABLE IF
 *   NOT EXISTS from the cron), so a fresh env doesn't 500 here just
 *   because the cron hasn't run yet.
 *
 * POST /api/admin/x-dm          — trigger a manual /api/x-dm-poll run.
 *   Uses the same pattern as /api/admin/cron-control: server-to-server
 *   fetch against our own GET endpoint with `Bearer CRON_SECRET` so
 *   the cron handler's auth check accepts it. Returns the upstream
 *   poll summary straight through.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TRIGGER_TIMEOUT_MS = 55_000;

interface DmLog {
  id: string;
  sender_id: string;
  sender_username: string | null;
  message_text: string;
  bot_reply: string | null;
  dm_event_id: string;
  status: string;
  error: string | null;
  created_at: string;
}

interface DmStats {
  total: number;
  replied: number;
  failed: number;
  oldest: string | null;
  newest: string | null;
}

async function ensureTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS x_dm_logs (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      sender_id       TEXT NOT NULL,
      sender_username TEXT,
      message_text    TEXT NOT NULL,
      bot_reply       TEXT,
      dm_event_id     TEXT UNIQUE,
      status          TEXT NOT NULL DEFAULT 'received',
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {
    // best-effort; the read below will report the real problem
  });
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ── GET: logs + stats ─────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  try {
    await ensureTable(sql);

    const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
    const logs = (await sql`
      SELECT * FROM x_dm_logs ORDER BY created_at DESC LIMIT ${limit}
    `) as unknown as DmLog[];

    const statsRows = (await sql`
      SELECT
        COUNT(*)::int                                  AS total,
        COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
        COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
        MIN(created_at)                                AS oldest,
        MAX(created_at)                                AS newest
      FROM x_dm_logs
    `) as unknown as DmStats[];

    return NextResponse.json({
      total: logs.length,
      stats: statsRows[0] ?? { total: 0, replied: 0, failed: 0, oldest: null, newest: null },
      logs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── POST: manual poll trigger ─────────────────────────────────────────

function getBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { triggered: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(`${getBaseUrl()}/api/x-dm-poll`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({ status: res.status }));
    return NextResponse.json({ triggered: res.ok, status: res.status, result: data });
  } catch (err) {
    return NextResponse.json(
      { triggered: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
