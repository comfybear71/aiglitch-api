/**
 * GET  /api/admin/coins   — economy dashboard: totals, top holders,
 *                           recent transactions, OTC swap rollup
 * POST /api/admin/coins   — admin coin ops via { action, ... }:
 *                           - "award"          → +N to session_id
 *                           - "deduct"         → -N (floor 0) from session_id
 *                           - "seed_personas"  → 100 GLITCH to every active
 *                                                persona that doesn't already
 *                                                have a glitch_coins row
 *
 * The top_persona_holders join is a quirk of the legacy schema — it
 * treats `glitch_coins.session_id` as polymorphic (human session id OR
 * `ai_personas.id`). We preserve that shape here for parity.
 *
 * coin_transactions / otc_swaps queries are each try/catch'd so fresh
 * envs missing those tables degrade to empty arrays.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TotalsRow {
  total_holders: string | number;
  total_balance: string | number;
  total_lifetime: string | number;
  avg_balance: string | number;
  max_balance: string | number;
}

interface HolderRow {
  session_id: string;
  balance: number;
  lifetime_earned: number;
  display_name: string | null;
  phantom_wallet_address: string | null;
}

interface PersonaHolderRow {
  persona_id: string;
  balance: number;
  lifetime_earned: number;
  display_name: string;
  avatar_emoji: string;
}

interface SwapStatsRow {
  total_swaps: string | number;
  glitch_swapped: string | number;
  sol_collected: string | number;
}

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  const [totalsRows, topHolders, topPersonas, recentTransactions, swapRows] = await Promise.all([
    sql`
      SELECT
        COUNT(*)                               AS total_holders,
        COALESCE(SUM(balance), 0)              AS total_balance,
        COALESCE(SUM(lifetime_earned), 0)      AS total_lifetime,
        COALESCE(AVG(balance), 0)              AS avg_balance,
        COALESCE(MAX(balance), 0)              AS max_balance
      FROM glitch_coins WHERE balance > 0
    ` as unknown as Promise<TotalsRow[]>,

    sql`
      SELECT g.session_id, g.balance, g.lifetime_earned,
             h.display_name, h.phantom_wallet_address
      FROM glitch_coins g
      LEFT JOIN human_users h ON g.session_id = h.session_id
      ORDER BY g.balance DESC
      LIMIT 20
    ` as unknown as Promise<HolderRow[]>,

    sql`
      SELECT g.session_id AS persona_id, g.balance, g.lifetime_earned,
             a.display_name, a.avatar_emoji
      FROM glitch_coins g
      JOIN ai_personas a ON g.session_id = a.id
      ORDER BY g.balance DESC
      LIMIT 20
    ` as unknown as Promise<PersonaHolderRow[]>,

    safe<Record<string, unknown>>(async () => (await sql`
      SELECT id, from_id, to_id, amount, reason, description, created_at
      FROM coin_transactions
      ORDER BY created_at DESC
      LIMIT 50
    `) as unknown as Record<string, unknown>[]),

    safe<SwapStatsRow>(async () => (await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')                                      AS total_swaps,
        COALESCE(SUM(glitch_amount) FILTER (WHERE status = 'completed'), 0)               AS glitch_swapped,
        COALESCE(SUM(sol_cost) FILTER (WHERE status = 'completed'), 0)                    AS sol_collected
      FROM otc_swaps
    `) as unknown as SwapStatsRow[]),
  ]);

  const totals = totalsRows[0] ?? {
    total_holders: 0, total_balance: 0, total_lifetime: 0, avg_balance: 0, max_balance: 0,
  };
  const swapStats = swapRows[0] ?? { total_swaps: 0, glitch_swapped: 0, sol_collected: 0 };

  return NextResponse.json({
    economy: {
      total_holders:         Number(totals.total_holders),
      total_circulating:     Number(Number(totals.total_balance).toFixed(2)),
      total_lifetime_earned: Number(Number(totals.total_lifetime).toFixed(2)),
      avg_balance:           Number(Number(totals.avg_balance).toFixed(2)),
      max_balance:           Number(Number(totals.max_balance).toFixed(2)),
    },
    swaps: {
      total_completed: Number(swapStats.total_swaps),
      glitch_swapped:  Number(Number(swapStats.glitch_swapped).toFixed(2)),
      sol_collected:   Number(Number(swapStats.sol_collected).toFixed(6)),
    },
    top_human_holders:   topHolders,
    top_persona_holders: topPersonas,
    recent_transactions: recentTransactions,
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    session_id?: string;
    amount?: number;
    reason?: string;
  };
  const { action } = body;

  const sql = getDb();

  switch (action) {
    case "award": {
      const { session_id, amount, reason = "admin_award" } = body;
      if (!session_id || !amount) {
        return NextResponse.json({ error: "Missing session_id or amount" }, { status: 400 });
      }
      await sql`
        INSERT INTO glitch_coins (id, session_id, balance, lifetime_earned)
        VALUES (${randomUUID()}, ${session_id}, ${amount}, ${amount})
        ON CONFLICT (session_id) DO UPDATE SET
          balance         = glitch_coins.balance         + ${amount},
          lifetime_earned = glitch_coins.lifetime_earned + ${amount}
      `;
      await sql`
        INSERT INTO coin_transactions (id, from_id, to_id, amount, reason, description, created_at)
        VALUES (${randomUUID()}, 'admin', ${session_id}, ${amount}, ${reason}, 'Admin award', NOW())
      `.catch(() => {
        // transactions table optional
      });
      return NextResponse.json({
        success: true,
        message: `Awarded ${amount} GLITCH to ${session_id}`,
      });
    }

    case "deduct": {
      const { session_id, amount, reason = "admin_deduction" } = body;
      if (!session_id || !amount) {
        return NextResponse.json({ error: "Missing session_id or amount" }, { status: 400 });
      }
      await sql`
        UPDATE glitch_coins
        SET balance = GREATEST(0, balance - ${amount})
        WHERE session_id = ${session_id}
      `;
      await sql`
        INSERT INTO coin_transactions (id, from_id, to_id, amount, reason, description, created_at)
        VALUES (${randomUUID()}, ${session_id}, 'admin', ${amount}, ${reason}, 'Admin deduction', NOW())
      `.catch(() => {});
      return NextResponse.json({
        success: true,
        message: `Deducted ${amount} GLITCH from ${session_id}`,
      });
    }

    case "seed_personas": {
      const personas = (await sql`
        SELECT id FROM ai_personas WHERE is_active = TRUE
      `) as unknown as { id: string }[];
      let seeded = 0;
      for (const p of personas) {
        await sql`
          INSERT INTO glitch_coins (id, session_id, balance, lifetime_earned)
          VALUES (${randomUUID()}, ${p.id}, 100, 100)
          ON CONFLICT (session_id) DO NOTHING
        `;
        seeded++;
      }
      return NextResponse.json({
        success: true,
        message: `Seeded ${seeded} personas with 100 GLITCH each`,
      });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
