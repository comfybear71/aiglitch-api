/**
 * GET /api/admin/swaps
 *
 * Read-only admin dashboard view of the OTC swap history + aggregate
 * stats pulled from the `otc_swaps` table. Paginated; supports status
 * filtering.
 *
 * Query params:
 *   ?limit=N          default 50, clamped to 200
 *   ?offset=N         default 0
 *   ?status=X         optional filter (completed | pending | failed)
 *
 * Scope: this is admin MONITORING only — no mutation, no trading logic.
 * The /api/otc-swap trading endpoint itself stays locked under Phase 8
 * (CLAUDE.md decision #6). This route is part of the admin dashboard
 * stack, same shape as /api/admin/coins, so the human admin can see
 * what swaps have happened.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface TotalsRow {
  total_swaps: string | number;
  completed_swaps: string | number;
  pending_swaps: string | number;
  failed_swaps: string | number;
  total_sol_volume: string | number;
  total_glitch_volume: string | number;
  avg_price: string | number;
}

interface SwapRow {
  id: string;
  buyer_wallet: string;
  glitch_amount: number;
  sol_cost: number;
  price_per_glitch: number;
  status: string;
  tx_signature: string | null;
  created_at: string;
  completed_at: string | null;
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

function parseOffset(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const url = request.nextUrl;
  const limit = parseLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));
  const statusFilter = url.searchParams.get("status");

  const totalsRows = (await sql`
    SELECT
      COUNT(*)                                                                          AS total_swaps,
      COUNT(*)                                   FILTER (WHERE status = 'completed')    AS completed_swaps,
      COUNT(*)                                   FILTER (WHERE status = 'pending')      AS pending_swaps,
      COUNT(*)                                   FILTER (WHERE status = 'failed')       AS failed_swaps,
      COALESCE(SUM(sol_cost),      0)            FILTER (WHERE status = 'completed')    AS total_sol_volume,
      COALESCE(SUM(glitch_amount), 0)            FILTER (WHERE status = 'completed')    AS total_glitch_volume,
      COALESCE(AVG(price_per_glitch), 0)         FILTER (WHERE status = 'completed')    AS avg_price
    FROM otc_swaps
  `) as unknown as TotalsRow[];

  const totals = totalsRows[0] ?? {
    total_swaps: 0, completed_swaps: 0, pending_swaps: 0, failed_swaps: 0,
    total_sol_volume: 0, total_glitch_volume: 0, avg_price: 0,
  };

  const swaps = (statusFilter
    ? await sql`
        SELECT id, buyer_wallet, glitch_amount, sol_cost, price_per_glitch,
               status, tx_signature, created_at, completed_at
        FROM otc_swaps
        WHERE status = ${statusFilter}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT id, buyer_wallet, glitch_amount, sol_cost, price_per_glitch,
               status, tx_signature, created_at, completed_at
        FROM otc_swaps
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as unknown as SwapRow[];

  return NextResponse.json({
    stats: {
      total_swaps:         Number(totals.total_swaps),
      completed_swaps:     Number(totals.completed_swaps),
      pending_swaps:       Number(totals.pending_swaps),
      failed_swaps:        Number(totals.failed_swaps),
      total_sol_volume:    Number(Number(totals.total_sol_volume).toFixed(6)),
      total_glitch_volume: Number(Number(totals.total_glitch_volume).toFixed(2)),
      avg_price:           Number(Number(totals.avg_price).toFixed(8)),
    },
    swaps,
    pagination: { limit, offset, returned: swaps.length },
  });
}
