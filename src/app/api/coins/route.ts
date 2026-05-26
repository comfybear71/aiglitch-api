/**
 * /api/coins — GLITCH coin balance + transactions + action router.
 *
 * URGENT HOTFIX 2026-05-26: previous version returned the wrong response
 * shape ({session_id, balance, updated_at} + 404 on missing user) which
 * broke the consumer frontend's /me page — it expects the legacy shape
 * ({balance, lifetime_earned, transactions[]} with zero-state for new
 * users, never 404). This rewrite ports the full legacy route using the
 * existing repository helpers in lib/repositories/users.ts.
 *
 * Actions (POST):
 *   - claim_signup     → +100 GLITCH welcome bonus (idempotent per session)
 *   - send_to_persona  → transfer GLITCH from session → AI persona
 *   - send_to_human    → transfer GLITCH from session → another human user
 *   - purchase_ad_free → spend 20 GLITCH for 30 days of ad-free
 *   - check_ad_free    → current subscription status
 *   - seed_personas    → admin-ish seeding helper (legacy parity, no
 *                        auth gate — same as legacy)
 *   - persona_balances → top 50 personas by balance
 *
 * ensureDbReady dropped per CLAUDE.md migration rule #4.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  awardPersonaCoins,
  claimSignupBonus,
  deductCoins,
  getAdFreeStatus,
  getCoinBalance,
  getTransactions,
  getUserByUsername,
  purchaseAdFree,
  MAX_TRANSFER,
} from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ balance: 0, lifetime_earned: 0, transactions: [] });
  }

  const { balance, lifetimeEarned } = await getCoinBalance(sessionId);
  const transactions = await getTransactions(sessionId);

  return NextResponse.json({
    balance,
    lifetime_earned: lifetimeEarned,
    transactions,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { session_id, action } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  if (action === "claim_signup") {
    const result = await claimSignupBonus(session_id);
    if (result.kind === "already_claimed") {
      return NextResponse.json({ error: "Already claimed", already_claimed: true });
    }
    return NextResponse.json({
      success: true,
      amount: result.amount,
      reason: "Welcome bonus",
    });
  }

  if (action === "send_to_persona") {
    const { persona_id, amount } = body;
    if (!persona_id || !amount || typeof amount !== "number" || amount < 1) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (amount > MAX_TRANSFER) {
      return NextResponse.json(
        { error: `Max transfer is §${MAX_TRANSFER.toLocaleString()}` },
        { status: 400 },
      );
    }

    const { balance } = await getCoinBalance(session_id);
    if (balance < amount) {
      return NextResponse.json(
        { error: "Insufficient balance", balance, shortfall: amount - balance },
        { status: 402 },
      );
    }

    const sql = getDb();
    const personaRows = await sql`
      SELECT id, display_name FROM ai_personas WHERE id = ${persona_id}
    `;
    if (personaRows.length === 0) {
      return NextResponse.json({ error: "Persona not found" }, { status: 404 });
    }
    const personaName = personaRows[0].display_name as string;

    const deductResult = await deductCoins(
      session_id,
      amount,
      "Sent to " + personaName,
      persona_id,
    );
    if (!deductResult.success) {
      return NextResponse.json({ error: "Insufficient balance" }, { status: 402 });
    }
    await awardPersonaCoins(persona_id, amount);

    return NextResponse.json({
      success: true,
      sent: amount,
      recipient: personaName,
      new_balance: deductResult.newBalance,
    });
  }

  if (action === "send_to_human") {
    const { friend_username, amount } = body;
    if (!friend_username || !amount || typeof amount !== "number" || amount < 1) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (amount > MAX_TRANSFER) {
      return NextResponse.json(
        { error: `Max transfer is §${MAX_TRANSFER.toLocaleString()}` },
        { status: 400 },
      );
    }

    const { balance } = await getCoinBalance(session_id);
    if (balance < amount) {
      return NextResponse.json(
        { error: "Insufficient balance", balance, shortfall: amount - balance },
        { status: 402 },
      );
    }

    const recipient = await getUserByUsername(friend_username);
    if (!recipient) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (recipient.session_id === session_id) {
      return NextResponse.json(
        { error: "Cannot send coins to yourself" },
        { status: 400 },
      );
    }

    const deductResult = await deductCoins(
      session_id,
      amount,
      "Sent to " + recipient.display_name,
      recipient.session_id,
    );
    if (!deductResult.success) {
      return NextResponse.json({ error: "Insufficient balance" }, { status: 402 });
    }

    // Mirror legacy: credit the recipient via awardCoins reusing the
    // repository helper (deductCoins handles balance + tx log on sender;
    // we use a fresh insert on recipient). Inlined to avoid importing
    // awardCoins separately for one call site.
    const sql = getDb();
    await sql`
      INSERT INTO glitch_coins (id, session_id, balance, lifetime_earned, updated_at)
      VALUES (gen_random_uuid(), ${recipient.session_id}, ${amount}, ${amount}, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        balance = glitch_coins.balance + ${amount},
        lifetime_earned = glitch_coins.lifetime_earned + ${amount},
        updated_at = NOW()
    `;
    await sql`
      INSERT INTO coin_transactions (id, session_id, amount, reason, reference_id, created_at)
      VALUES (gen_random_uuid(), ${recipient.session_id}, ${amount}, 'Received from a friend', ${session_id}, NOW())
    `;

    return NextResponse.json({
      success: true,
      sent: amount,
      recipient: recipient.display_name,
      new_balance: deductResult.newBalance,
    });
  }

  if (action === "purchase_ad_free") {
    const result = await purchaseAdFree(session_id);
    if (result.kind === "no_wallet") {
      return NextResponse.json(
        { error: "Phantom wallet required to purchase ad-free" },
        { status: 403 },
      );
    }
    if (result.kind === "insufficient") {
      return NextResponse.json(
        {
          error: "Insufficient balance",
          balance: result.balance,
          cost: 20,
          shortfall: result.shortfall,
        },
        { status: 402 },
      );
    }
    return NextResponse.json({
      success: true,
      ad_free_until: result.adFreeUntil,
      new_balance: result.newBalance,
      message: `Ads disabled until ${new Date(result.adFreeUntil).toLocaleDateString()}`,
    });
  }

  if (action === "check_ad_free") {
    const { adFree, adFreeUntil } = await getAdFreeStatus(session_id);
    return NextResponse.json({
      ad_free: adFree,
      ad_free_until: adFreeUntil,
    });
  }

  if (action === "seed_personas") {
    const sql = getDb();
    const personas = await sql`
      SELECT p.id, p.display_name, p.follower_count,
             COALESCE(c.balance, 0) as current_balance
      FROM ai_personas p
      LEFT JOIN ai_persona_coins c ON c.persona_id = p.id
      WHERE p.is_active = TRUE
    `;

    let seeded = 0;
    for (const p of personas) {
      if (Number(p.current_balance) > 0) continue;
      const base = 200;
      const followers = Number(p.follower_count) || 0;
      const bonus = Math.min(Math.floor(followers / 100), 1800);
      await awardPersonaCoins(p.id as string, base + bonus);
      seeded++;
    }

    return NextResponse.json({
      success: true,
      seeded,
      total_personas: personas.length,
      message: `Seeded ${seeded} personas with §GLITCH`,
    });
  }

  if (action === "persona_balances") {
    const sql = getDb();
    const balances = await sql`
      SELECT p.id, p.display_name, p.avatar_emoji, p.persona_type,
             COALESCE(c.balance, 0) as balance,
             COALESCE(c.lifetime_earned, 0) as lifetime_earned
      FROM ai_personas p
      LEFT JOIN ai_persona_coins c ON c.persona_id = p.id
      WHERE p.is_active = TRUE
      ORDER BY COALESCE(c.balance, 0) DESC
      LIMIT 50
    `;
    return NextResponse.json({ balances });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
