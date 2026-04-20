/**
 * User-side writes used by /api/interact's coin-award side-effects, plus
 * the read helpers /api/coins Slice 1 (GET) needs.
 *
 * Deduct / transfer functions land with Slice 2+. They're called inside
 * try/catch wrappers in interactions.ts because legacy treats them as
 * non-critical: a failed coin credit should never block the user action
 * that triggered it.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface CoinBalance {
  balance: number;
  lifetimeEarned: number;
}

export interface CoinTransactionRow {
  amount: number;
  reason: string;
  created_at: string;
}

/**
 * GLITCH coin balance for a session. Returns zeros when the session has
 * no glitch_coins row yet (legacy parity — first-time readers shouldn't
 * error, they should see 0).
 */
export async function getCoinBalance(sessionId: string): Promise<CoinBalance> {
  const sql = getDb();
  const rows = (await sql`
    SELECT balance, lifetime_earned FROM glitch_coins WHERE session_id = ${sessionId}
  `) as unknown as Array<{ balance: number; lifetime_earned: number }>;
  if (rows.length === 0) return { balance: 0, lifetimeEarned: 0 };
  return {
    balance: Number(rows[0]!.balance),
    lifetimeEarned: Number(rows[0]!.lifetime_earned),
  };
}

/**
 * Recent coin transactions for a session (newest first). Default 20,
 * matching legacy. Awards log positive amounts, deducts (Slice 2+)
 * will log negative.
 */
export async function getTransactions(
  sessionId: string,
  limit = 20,
): Promise<CoinTransactionRow[]> {
  const sql = getDb();
  return (await sql`
    SELECT amount, reason, created_at FROM coin_transactions
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as unknown as CoinTransactionRow[];
}

/** Award GLITCH coins to a human (session). Upserts balance + lifetime_earned and logs the transaction. */
export async function awardCoins(
  sessionId: string,
  amount: number,
  reason: string,
  referenceId?: string,
): Promise<number> {
  const sql = getDb();
  await sql`
    INSERT INTO glitch_coins (id, session_id, balance, lifetime_earned, updated_at)
    VALUES (${randomUUID()}, ${sessionId}, ${amount}, ${amount}, NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      balance = glitch_coins.balance + ${amount},
      lifetime_earned = glitch_coins.lifetime_earned + ${amount},
      updated_at = NOW()
  `;
  await sql`
    INSERT INTO coin_transactions (id, session_id, amount, reason, reference_id, created_at)
    VALUES (${randomUUID()}, ${sessionId}, ${amount}, ${reason}, ${referenceId ?? null}, NOW())
  `;
  return amount;
}

/** Award GLITCH coins to an AI persona. Separate table, no transaction log (legacy parity). */
export async function awardPersonaCoins(
  personaId: string,
  amount: number,
): Promise<number> {
  const sql = getDb();
  await sql`
    INSERT INTO ai_persona_coins (id, persona_id, balance, lifetime_earned, updated_at)
    VALUES (${randomUUID()}, ${personaId}, ${amount}, ${amount}, NOW())
    ON CONFLICT (persona_id) DO UPDATE SET
      balance = ai_persona_coins.balance + ${amount},
      lifetime_earned = ai_persona_coins.lifetime_earned + ${amount},
      updated_at = NOW()
  `;
  return amount;
}
