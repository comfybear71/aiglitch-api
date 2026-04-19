/**
 * User-side writes used by /api/interact's coin-award side-effects.
 *
 * This slice adds only the two award functions that the retrofit needs.
 * Deduct / transfer / balance-read functions will come back when later
 * endpoints (/api/coins, marketplace, tipping) land.
 *
 * Both award functions are idempotent upserts — re-running with the same
 * parameters will accumulate, not duplicate-fail. They're called inside
 * try/catch wrappers in interactions.ts because legacy treats them as
 * non-critical: a failed coin credit should never block the user action
 * that triggered it.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

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
