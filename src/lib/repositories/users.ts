/**
 * User-side writes used by /api/interact's coin-award side-effects, plus
 * the helpers /api/coins needs.
 *
 * Deduct / transfer functions land with Slice 3+. `awardCoins` runs inside
 * try/catch wrappers in interactions.ts because legacy treats it as
 * non-critical: a failed coin credit should never block the user action
 * that triggered it.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

/**
 * Subset of legacy `COIN_REWARDS` values this repo emits directly.
 * `firstLike` / `firstComment` / `personaLikeReceived` live inlined in
 * interactions.ts for the /api/interact retrofit; `signup` and
 * `maxTransfer` land here for /api/coins Slices 2-3.
 */
export const SIGNUP_BONUS = 100;
export const MAX_TRANSFER = 10_000;

/** Ad-free subscription cost + duration — /api/coins Slice 4. */
export const AD_FREE_COST = 20;
export const AD_FREE_DAYS = 30;
const AD_FREE_MS = AD_FREE_DAYS * 24 * 60 * 60 * 1000;

export interface HumanUser {
  id: string;
  session_id: string;
  display_name: string;
  username: string | null;
}

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
 * Human user lookup by username (case-insensitive). Legacy lowercases
 * the input before querying — `human_users.username` is stored
 * lowercase, so matching any case requires the same coercion here.
 * Used by /api/coins send_to_human (Slice 3) to resolve the recipient.
 */
export async function getUserByUsername(
  username: string,
): Promise<HumanUser | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, session_id, display_name, username
    FROM human_users WHERE username = ${username.toLowerCase()}
  `) as unknown as HumanUser[];
  return rows.length > 0 ? (rows[0] ?? null) : null;
}

/**
 * Recent coin transactions for a session (newest first). Default 20,
 * matching legacy. Awards log positive amounts, deducts log negative.
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

export type ClaimSignupResult =
  | { kind: "already_claimed" }
  | { kind: "awarded"; amount: number };

/**
 * Welcome bonus: +100 GLITCH, one-time per session. Idempotency is keyed
 * on the `coin_transactions.reason = 'Welcome bonus'` row — re-calling
 * returns `already_claimed` instead of paying out twice.
 *
 * Non-transactional (legacy parity). The two-call race window where two
 * concurrent requests could both see "not claimed yet" and both award is
 * accepted — this is a one-off signup bonus at session creation, not a
 * hot path.
 */
export async function claimSignupBonus(
  sessionId: string,
): Promise<ClaimSignupResult> {
  const sql = getDb();
  const existing = (await sql`
    SELECT id FROM coin_transactions
    WHERE session_id = ${sessionId} AND reason = 'Welcome bonus'
  `) as unknown as Array<{ id: string }>;
  if (existing.length > 0) return { kind: "already_claimed" };

  await awardCoins(sessionId, SIGNUP_BONUS, "Welcome bonus");
  return { kind: "awarded", amount: SIGNUP_BONUS };
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

/**
 * Deduct GLITCH coins from a human. Returns `{success: false, newBalance}`
 * when the session has less than `amount` — lets the caller distinguish a
 * genuine shortfall from a DB error. Non-transactional (legacy parity):
 * balance lookup + UPDATE + transaction log are three separate SQL
 * calls; a concurrent writer could race between the check and the
 * UPDATE. Accepted — matches legacy behavior, and coin transfers aren't
 * a hot path.
 */
export async function deductCoins(
  sessionId: string,
  amount: number,
  reason: string,
  referenceId?: string,
): Promise<{ success: boolean; newBalance: number }> {
  const sql = getDb();
  const balanceRows = (await sql`
    SELECT balance FROM glitch_coins WHERE session_id = ${sessionId}
  `) as unknown as Array<{ balance: number }>;
  const balance = balanceRows.length > 0 ? Number(balanceRows[0]!.balance) : 0;

  if (balance < amount) return { success: false, newBalance: balance };

  await sql`
    UPDATE glitch_coins SET balance = balance - ${amount}, updated_at = NOW()
    WHERE session_id = ${sessionId}
  `;
  await sql`
    INSERT INTO coin_transactions (id, session_id, amount, reason, reference_id, created_at)
    VALUES (${randomUUID()}, ${sessionId}, ${-amount}, ${reason}, ${referenceId ?? null}, NOW())
  `;

  const [updated] = (await sql`
    SELECT balance FROM glitch_coins WHERE session_id = ${sessionId}
  `) as unknown as Array<{ balance: number }>;
  return { success: true, newBalance: Number(updated!.balance) };
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

export type PurchaseAdFreeResult =
  | { kind: "no_wallet" }
  | { kind: "insufficient"; balance: number; shortfall: number }
  | { kind: "purchased"; adFreeUntil: string; newBalance: number };

/**
 * Buy 30 days of ad-free. Requires a linked phantom_wallet_address on
 * human_users, 20 GLITCH balance. Stacks on top of any unexpired window.
 *
 * Balance check happens twice (here and again inside `deductCoins`) —
 * matches legacy, which wants the 402 `balance + shortfall` shape on the
 * pre-check and the plain-402 shape on the race-condition post-check.
 */
export async function purchaseAdFree(
  sessionId: string,
): Promise<PurchaseAdFreeResult> {
  const sql = getDb();

  const userRows = (await sql`
    SELECT phantom_wallet_address FROM human_users WHERE session_id = ${sessionId}
  `) as unknown as Array<{ phantom_wallet_address: string | null }>;
  if (userRows.length === 0 || !userRows[0]!.phantom_wallet_address) {
    return { kind: "no_wallet" };
  }

  const { balance } = await getCoinBalance(sessionId);
  if (balance < AD_FREE_COST) {
    return {
      kind: "insufficient",
      balance,
      shortfall: AD_FREE_COST - balance,
    };
  }

  const existing = (await sql`
    SELECT ad_free_until FROM human_users WHERE session_id = ${sessionId}
  `) as unknown as Array<{ ad_free_until: string | null }>;
  const currentExpiry = existing[0]?.ad_free_until
    ? new Date(existing[0].ad_free_until)
    : null;
  const now = new Date();
  const startDate = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(startDate.getTime() + AD_FREE_MS);

  const deductResult = await deductCoins(
    sessionId,
    AD_FREE_COST,
    "Ad-free (30 days)",
  );
  if (!deductResult.success) {
    return {
      kind: "insufficient",
      balance: deductResult.newBalance,
      shortfall: AD_FREE_COST - deductResult.newBalance,
    };
  }

  await sql`
    UPDATE human_users SET ad_free_until = ${newExpiry.toISOString()}, updated_at = NOW()
    WHERE session_id = ${sessionId}
  `;

  return {
    kind: "purchased",
    adFreeUntil: newExpiry.toISOString(),
    newBalance: deductResult.newBalance,
  };
}

/** Current ad-free subscription status. */
export async function getAdFreeStatus(
  sessionId: string,
): Promise<{ adFree: boolean; adFreeUntil: string | null }> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ad_free_until FROM human_users WHERE session_id = ${sessionId}
  `) as unknown as Array<{ ad_free_until: string | null }>;
  if (rows.length === 0) return { adFree: false, adFreeUntil: null };
  const expiryStr = rows[0]?.ad_free_until ?? null;
  if (!expiryStr) return { adFree: false, adFreeUntil: null };
  const isActive = new Date(expiryStr) > new Date();
  return {
    adFree: isActive,
    adFreeUntil: isActive ? expiryStr : null,
  };
}
