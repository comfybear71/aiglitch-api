/**
 * GET  /api/admin/cron-control — admin dashboard: list crons, their
 *   last run status, 24h aggregate stats, and recent 100-row history.
 *   Schema keys match our `cron_runs` table (cron_name, status='ok'/
 *   'error'/'running').
 *
 * POST /api/admin/cron-control — manually trigger a cron by name. The
 *   endpoint table here is the source of truth for "crons we can
 *   trigger from the dashboard" — keep it in sync with vercel.json.
 *   We forward to our own cron endpoint with `Authorization: Bearer
 *   CRON_SECRET` so the GET handler's `requireCronAuth` check passes.
 *
 * Body: { job: string } — job name from the endpoint table keys.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Known cron registry ───────────────────────────────────────────────
// Keys match the first arg of cronHandler(...) in each route — used to
// join against `cron_runs.cron_name`. Add new crons here as they port.

interface CronEntry {
  name: string;
  endpoint: string;
  method: "GET" | "POST";
  schedule: string;
  description: string;
}

const CRONS: CronEntry[] = [
  { name: "sponsor-burn",              endpoint: "/api/sponsor-burn",              method: "POST", schedule: "Daily at 00:00",   description: "Per-sponsor campaign daily burn + catch-up" },
  { name: "telegram-credit-check",     endpoint: "/api/telegram/credit-check",     method: "GET",  schedule: "Every 30 min",      description: "AI spend + sponsor balance alerts" },
  { name: "telegram-status",           endpoint: "/api/telegram/status",           method: "GET",  schedule: "Every 6 hours",     description: "Platform status report to admin channel" },
  { name: "telegram-persona-message",  endpoint: "/api/telegram/persona-message",  method: "GET",  schedule: "Every 3 hours",     description: "Persona posts to Telegram" },
  { name: "x-dm-poll",                 endpoint: "/api/x-dm-poll",                 method: "GET",  schedule: "Every 15 min",      description: "Poll X DMs, auto-reply" },
  { name: "x-react",                   endpoint: "/api/x-react",                   method: "GET",  schedule: "Every 10 min",      description: "X reaction engine" },
  { name: "marketing-metrics",         endpoint: "/api/marketing-metrics",         method: "GET",  schedule: "Hourly",            description: "Collect cross-platform marketing metrics" },
  { name: "persona-comments",          endpoint: "/api/persona-comments",          method: "GET",  schedule: "Every 2 hours",     description: "AI persona comment chains" },
  { name: "feedback-loop",             endpoint: "/api/feedback-loop",             method: "GET",  schedule: "Every 6 hours",     description: "Emoji feedback → channel prompt tuning" },
  { name: "generate-topics",           endpoint: "/api/generate-topics",           method: "GET",  schedule: "Every 2 hours",     description: "Daily briefing + breaking news posts" },
];

// ── Types for cron_runs rows ──────────────────────────────────────────

interface LatestRunRow {
  id: string;
  cron_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  cost_usd: string | null; // NUMERIC comes back as string
  result: unknown;
  error: string | null;
}

interface HistoryRow {
  id: string;
  cron_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  cost_usd: string | null;
  error: string | null;
}

interface StatsRow {
  total_runs: number | string;
  successful: number | string;
  failed: number | string;
  total_cost: string | number;
  unique_jobs: number | string;
}

// ── GET: dashboard payload ────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  // Each query is fault-tolerant — when cron_runs doesn't exist yet
  // (fresh env), we still return the static cron registry.
  const latestRuns: LatestRunRow[] = await (sql`
    SELECT DISTINCT ON (cron_name)
      id, cron_name, status, started_at, finished_at, duration_ms, cost_usd, result, error
    FROM cron_runs
    ORDER BY cron_name, started_at DESC
  ` as unknown as Promise<LatestRunRow[]>).catch(() => []);

  const history: HistoryRow[] = await (sql`
    SELECT id, cron_name, status, started_at, finished_at, duration_ms, cost_usd, error
    FROM cron_runs
    ORDER BY started_at DESC
    LIMIT 100
  ` as unknown as Promise<HistoryRow[]>).catch(() => []);

  const statsRows: StatsRow[] = await (sql`
    SELECT
      COUNT(*)                                   AS total_runs,
      COUNT(*) FILTER (WHERE status = 'ok')      AS successful,
      COUNT(*) FILTER (WHERE status = 'error')   AS failed,
      COALESCE(SUM(cost_usd), 0)                 AS total_cost,
      COUNT(DISTINCT cron_name)                  AS unique_jobs
    FROM cron_runs
    WHERE started_at > NOW() - INTERVAL '24 hours'
  ` as unknown as Promise<StatsRow[]>).catch(() => [
    { total_runs: 0, successful: 0, failed: 0, total_cost: 0, unique_jobs: 0 },
  ]);
  const stats = statsRows[0] ?? {
    total_runs: 0,
    successful: 0,
    failed: 0,
    total_cost: 0,
    unique_jobs: 0,
  };

  const latestByName = new Map(latestRuns.map((r) => [r.cron_name, r]));

  return NextResponse.json({
    cron_jobs: CRONS.map((c) => {
      const lastRun = latestByName.get(c.name);
      return {
        ...c,
        last_status: lastRun?.status ?? "never_run",
        last_run: lastRun?.started_at ?? null,
        last_duration_ms: lastRun?.duration_ms ?? null,
        last_cost_usd: lastRun?.cost_usd != null ? Number(lastRun.cost_usd) : null,
        last_error: lastRun?.error ?? null,
      };
    }),
    stats_24h: {
      total_runs: Number(stats.total_runs),
      successful: Number(stats.successful),
      failed: Number(stats.failed),
      total_cost_usd: Number(Number(stats.total_cost).toFixed(4)),
      unique_jobs: Number(stats.unique_jobs),
    },
    recent_history: history,
  });
}

// ── POST: trigger a cron on demand ────────────────────────────────────

function getBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { job } = (await request.json().catch(() => ({}))) as { job?: string };
  if (!job) {
    return NextResponse.json({ error: "Missing job name" }, { status: 400 });
  }

  const entry = CRONS.find((c) => c.name === job);
  if (!entry) {
    return NextResponse.json(
      { error: `Unknown cron job: ${job}`, available: CRONS.map((c) => c.name) },
      { status: 400 },
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { success: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(`${getBaseUrl()}${entry.endpoint}`, {
      method: entry.method,
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json().catch(() => ({ status: res.status }));

    return NextResponse.json({
      success: res.ok,
      job,
      endpoint: entry.endpoint,
      status: res.status,
      result: data,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        job,
        error: err instanceof Error ? err.message : "Failed to trigger job",
      },
      { status: 500 },
    );
  }
}
