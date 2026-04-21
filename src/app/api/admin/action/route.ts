/**
 * POST /api/admin/action { action }
 *
 * One-button maintenance operations from the admin dashboard / mobile
 * app. Supported actions:
 *
 *   "clear_cache"      — flush the in-process L1 cache (L2 Redis entries
 *                        expire naturally via TTL)
 *   "heal_personas"    — re-activate orphan seed personas that ended up
 *                        is_active=FALSE without a linked wallet
 *   "sync_balances"    — SELECT-only sanity check on glitch_coins totals
 *   "run_diagnostics"  — row counts + last 5 cron_runs (safe, all
 *                        optional tables swallowed)
 *   "refresh_personas" — NOT YET MIGRATED (501). Requires SEED_PERSONAS
 *                        static data from @/lib/personas; only the type
 *                        interface has been ported so far.
 *   "generate_content" — NOT YET MIGRATED (501). Forwards to
 *                        /api/generate, which is a Phase 6 cron still
 *                        blocked on the media stack port.
 *
 * Result shape: { success, message, details? }. HTTP 200 on success,
 * 501 for deferred actions, 500 on execution error, 400 on unknown
 * action.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { cache } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ActionResult {
  success: boolean;
  message: string;
  details?: unknown;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const action = body.action;
  if (!action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  // ── Deferred actions — surface 501 with a clear reason ──
  if (action === "refresh_personas") {
    return NextResponse.json(
      {
        success: false,
        message: "refresh_personas is not yet migrated",
        details: {
          reason: "SEED_PERSONAS static data hasn't been ported to this repo yet (only the AIPersona interface is available). Once ported, this action will re-seed ai_personas from the static catalog.",
        },
      },
      { status: 501 },
    );
  }
  if (action === "generate_content") {
    return NextResponse.json(
      {
        success: false,
        message: "generate_content is not yet migrated",
        details: {
          reason: "/api/generate is a Phase 6 cron still blocked on the media stack port (image-gen, multi-clip, etc.). Trigger content generation via /api/persona-comments or /api/generate-topics for now.",
        },
      },
      { status: 501 },
    );
  }

  try {
    const result = await executeAction(action);
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function executeAction(action: string): Promise<ActionResult> {
  const sql = getDb();

  switch (action) {
    case "clear_cache": {
      cache.clear();
      return {
        success: true,
        message: "L1 cache cleared. L2 (Redis) TTLs will expire naturally.",
      };
    }

    case "heal_personas": {
      const healed = (await sql`
        UPDATE ai_personas
        SET is_active = TRUE, is_dead = FALSE
        WHERE is_active = FALSE AND owner_wallet_address IS NULL
        RETURNING id
      `) as unknown as { id: string }[];
      cache.del("personas:active");
      return {
        success: true,
        message: `Healed ${healed.length} seed personas`,
        details: { ids: healed.map((r) => r.id) },
      };
    }

    case "sync_balances": {
      const rows = (await sql`
        SELECT
          COUNT(*)::int                       AS total_holders,
          COALESCE(SUM(balance), 0)::numeric  AS total_circulating
        FROM glitch_coins WHERE balance > 0
      `) as unknown as { total_holders: number; total_circulating: string | number }[];
      const row = rows[0];
      return {
        success: true,
        message: "Balance check complete",
        details: {
          holders: Number(row?.total_holders ?? 0),
          total_circulating: Number(row?.total_circulating ?? 0),
        },
      };
    }

    case "run_diagnostics": {
      const [postCount, personaCount, userCount, deadPersonas, stalePersonas] = await Promise.all([
        sql`SELECT COUNT(*)::int AS count FROM posts`           .catch(() => [{ count: 0 }]),
        sql`SELECT COUNT(*)::int AS count FROM ai_personas`     .catch(() => [{ count: 0 }]),
        sql`SELECT COUNT(*)::int AS count FROM human_users`     .catch(() => [{ count: 0 }]),
        sql`SELECT COUNT(*)::int AS count FROM ai_personas WHERE is_dead = TRUE`     .catch(() => [{ count: 0 }]),
        sql`SELECT COUNT(*)::int AS count FROM ai_personas WHERE is_active = FALSE`  .catch(() => [{ count: 0 }]),
      ]);
      // cron_runs schema uses `cron_name` in this repo (NOT job_name as in legacy)
      const lastCron = await (sql`
        SELECT cron_name, status, started_at, error
        FROM cron_runs
        ORDER BY started_at DESC
        LIMIT 5
      `).catch(() => [] as unknown[]);

      return {
        success: true,
        message: "Diagnostics complete",
        details: {
          posts:             Number((postCount    as unknown as { count: number }[])[0]?.count ?? 0),
          personas:          Number((personaCount as unknown as { count: number }[])[0]?.count ?? 0),
          users:             Number((userCount    as unknown as { count: number }[])[0]?.count ?? 0),
          dead_personas:     Number((deadPersonas as unknown as { count: number }[])[0]?.count ?? 0),
          inactive_personas: Number((stalePersonas as unknown as { count: number }[])[0]?.count ?? 0),
          recent_crons:      lastCron,
        },
      };
    }

    default:
      return { success: false, message: `Unknown action: ${action}` };
  }
}
