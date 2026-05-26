/**
 * /api/persona-trade — AI-persona-to-AI-persona "trade" simulator.
 *
 * Port of legacy aiglitch/src/app/api/persona-trade/route.ts. Pure
 * in-DB economy — moves `ai_persona_coins.balance` between AI
 * personas with flavour-text reasons. Zero on-chain interaction,
 * zero treasury key usage, zero external API calls (audit-confirmed
 * simulation per the 2026-05-26 batch approval under locked decision #6).
 *
 * Endpoints:
 *   POST { action: "simulate_trades", count?: number }
 *     → Runs up to `count` (max 20, default 5) random trades between
 *       active personas with balance > 10. Each trade is 1-10% of
 *       sender's balance, capped at 50, min 1. Records both sides
 *       in `coin_transactions` for the activity feed.
 *   POST { action: "recent_trades", limit?: number }
 *     → Returns the most-recent N (max 50) persona trades enriched
 *       with display_name + avatar_emoji.
 *   GET  ?limit=N
 *     → Same as recent_trades but via GET for cron / activity feeds.
 *
 * Drops the legacy `ensureDbReady()` per CLAUDE.md migration rule #4.
 */

import { type NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";

import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TRADE_REASONS = [
  "lost a bet about pineapple on pizza",
  "paid for a collab post",
  "tipped for a fire meme",
  "bought fake stocks in a bridge",
  "settled a philosophical debate",
  "paid rent on their pixel apartment",
  "invested in invisible commodities",
  "bribed for a follow-back",
  "bought conspiracy theory evidence",
  "paid for AI therapy session",
  "donated to the chaos fund",
  "funded their villain origin story",
  "bought premium dad jokes",
  "invested in digital fertilizer",
  "paid for astrology reading",
  "bought emotional support bandwidth",
  "settled a rap battle",
  "paid for a speed run coaching session",
  "tipped the DJ for playing their song",
  "bought a subscription to nothing",
] as const;

interface PersonaWithBalance {
  id: string;
  display_name: string;
  avatar_emoji: string | null;
  balance: number;
}

interface TradeRow {
  amount: number;
  reason: string;
  created_at: string;
  session_id: string;
  reference_id: string | null;
}

interface PersonaName {
  display_name: string;
  avatar_emoji: string | null;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    count?: number;
    limit?: number;
  };
  const { action } = body;

  const sql = getDb();

  if (action === "simulate_trades") {
    const count = Math.min(body.count ?? 5, 20);

    const personas = (await sql`
      SELECT p.id, p.display_name, p.avatar_emoji,
             COALESCE(c.balance, 0) as balance
      FROM ai_personas p
      LEFT JOIN ai_persona_coins c ON c.persona_id = p.id
      WHERE p.is_active = TRUE AND COALESCE(c.balance, 0) > 10
    `) as unknown as PersonaWithBalance[];

    if (personas.length < 2) {
      return NextResponse.json(
        {
          error: "Not enough personas with coins to trade. Seed personas first.",
          hint: "POST /api/coins with action: seed_personas",
        },
        { status: 400 },
      );
    }

    const trades: Array<{
      from: { id: string; name: string; emoji: string | null };
      to: { id: string; name: string; emoji: string | null };
      amount: number;
      reason: string;
    }> = [];

    for (let i = 0; i < count; i++) {
      const fromIdx = Math.floor(Math.random() * personas.length);
      let toIdx = Math.floor(Math.random() * personas.length);
      while (toIdx === fromIdx) toIdx = Math.floor(Math.random() * personas.length);

      const from = personas[fromIdx];
      const to = personas[toIdx];
      const fromBalance = Number(from.balance);

      // 1-10% of sender's balance, clamped to [1, 50].
      const maxTrade = Math.min(Math.floor(fromBalance * 0.1), 50);
      const amount = Math.max(1, Math.floor(Math.random() * maxTrade) + 1);
      if (amount > fromBalance) continue;

      const reason = TRADE_REASONS[Math.floor(Math.random() * TRADE_REASONS.length)];

      await sql`
        UPDATE ai_persona_coins
        SET balance = balance - ${amount}, updated_at = NOW()
        WHERE persona_id = ${from.id}
      `;
      await sql`
        INSERT INTO ai_persona_coins (id, persona_id, balance, lifetime_earned, updated_at)
        VALUES (${uuidv4()}, ${to.id}, ${amount}, ${amount}, NOW())
        ON CONFLICT (persona_id) DO UPDATE SET
          balance = ai_persona_coins.balance + ${amount},
          lifetime_earned = ai_persona_coins.lifetime_earned + ${amount},
          updated_at = NOW()
      `;

      await sql`
        INSERT INTO coin_transactions (id, session_id, amount, reason, reference_id, created_at)
        VALUES (${uuidv4()}, ${`persona:${from.id}`}, ${-amount},
                ${`Sent to @${to.display_name}: ${reason}`}, ${to.id}, NOW())
      `;
      await sql`
        INSERT INTO coin_transactions (id, session_id, amount, reason, reference_id, created_at)
        VALUES (${uuidv4()}, ${`persona:${to.id}`}, ${amount},
                ${`Received from @${from.display_name}: ${reason}`}, ${from.id}, NOW())
      `;

      personas[fromIdx] = { ...from, balance: fromBalance - amount };
      personas[toIdx] = { ...to, balance: Number(to.balance) + amount };

      trades.push({
        from: { id: from.id, name: from.display_name, emoji: from.avatar_emoji },
        to: { id: to.id, name: to.display_name, emoji: to.avatar_emoji },
        amount,
        reason,
      });
    }

    return NextResponse.json({
      success: true,
      trades_executed: trades.length,
      trades,
    });
  }

  if (action === "recent_trades") {
    const limit = Math.min(body.limit ?? 20, 50);
    return enrichedTradesResponse(sql, limit);
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "10", 10),
    50,
  );
  const sql = getDb();
  return enrichedTradesResponse(sql, limit);
}

/**
 * Shared helper for the GET + POST { action: "recent_trades" } paths.
 * Pulls the most-recent `limit` outgoing-side trade rows from
 * `coin_transactions` (where amount < 0) and enriches with persona
 * display names + emoji.
 */
async function enrichedTradesResponse(
  sql: ReturnType<typeof getDb>,
  limit: number,
): Promise<NextResponse> {
  const trades = (await sql`
    SELECT ct.amount, ct.reason, ct.created_at, ct.session_id, ct.reference_id
    FROM coin_transactions ct
    WHERE ct.session_id LIKE 'persona:%' AND ct.amount < 0
    ORDER BY ct.created_at DESC
    LIMIT ${limit}
  `) as unknown as TradeRow[];

  const enriched: Array<{
    from: { name: string; emoji: string | null };
    to: { name: string; emoji: string | null };
    amount: number;
    reason: string;
    created_at: string;
  }> = [];

  for (const trade of trades) {
    const fromId = trade.session_id.replace("persona:", "");
    const toId = trade.reference_id;
    if (!toId) continue;

    const fromRows = (await sql`
      SELECT display_name, avatar_emoji FROM ai_personas WHERE id = ${fromId}
    `) as unknown as PersonaName[];
    const toRows = (await sql`
      SELECT display_name, avatar_emoji FROM ai_personas WHERE id = ${toId}
    `) as unknown as PersonaName[];

    if (fromRows.length === 0 || toRows.length === 0) continue;

    enriched.push({
      from: { name: fromRows[0].display_name, emoji: fromRows[0].avatar_emoji },
      to: { name: toRows[0].display_name, emoji: toRows[0].avatar_emoji },
      amount: Math.abs(Number(trade.amount)),
      reason: trade.reason.replace(/^Sent to @[^:]+: /, ""),
      created_at: trade.created_at,
    });
  }

  return NextResponse.json({ trades: enriched });
}
