/**
 * GET  /api/bestie-health?session_id=...  — bestie health status for the session
 * POST /api/bestie-health                 — feed GLITCH to extend bestie life
 *
 * Health decays 1% per day (100 days from last interaction → dead).
 * Bonus days from GLITCH extend the total lifespan beyond the 100-day
 * window. A single Telegram reply resets `last_meatbag_interaction` to
 * NOW (handled in the persona-chat webhook, not here).
 *
 * `calculateHealth` is exported so the forthcoming /api/bestie-life
 * cron can reuse it — that's the only non-route consumer.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCoinBalance, deductCoins } from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GLITCH_PER_100_DAYS = 1000;
const DAYS_PER_GLITCH = 100 / GLITCH_PER_100_DAYS; // 0.1 days per GLITCH
const MIN_FEED_GLITCH = 100;

/**
 * Pure function — no DB, no side effects. Returns computed health %
 * (0-100) + remaining effective days + dead flag. Health is capped at
 * 100 even when bonus days give "surplus" lifespan.
 */
export function calculateHealth(
  lastInteraction: Date,
  bonusDays: number,
): { health: number; effectiveDaysLeft: number; isDead: boolean } {
  const now = new Date();
  const daysSince = (now.getTime() - lastInteraction.getTime()) / (1000 * 60 * 60 * 24);
  const totalProtected = 100 + bonusDays;
  const effectiveDaysLeft = Math.max(0, totalProtected - daysSince);
  const health = Math.min(100, Math.max(0, (effectiveDaysLeft / totalProtected) * 100));
  const isDead = effectiveDaysLeft <= 0;

  return {
    health: Math.round(health * 10) / 10,
    effectiveDaysLeft: Math.round(effectiveDaysLeft * 10) / 10,
    isDead,
  };
}

interface UserWallet {
  phantom_wallet_address: string | null;
}

interface PersonaHealthRow {
  id: string;
  display_name: string;
  avatar_emoji: string;
  username: string;
  health: number;
  last_meatbag_interaction: string;
  bonus_health_days: number;
  is_dead: boolean;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const sql = getDb();

  const userRows = (await sql`
    SELECT phantom_wallet_address FROM human_users WHERE session_id = ${sessionId}
  `) as unknown as UserWallet[];

  if (!userRows[0]?.phantom_wallet_address) {
    return NextResponse.json({ has_persona: false });
  }

  const personaRows = (await sql`
    SELECT id, display_name, avatar_emoji, username, health,
           last_meatbag_interaction, bonus_health_days, is_dead
    FROM ai_personas
    WHERE owner_wallet_address = ${userRows[0].phantom_wallet_address}
    LIMIT 1
  `) as unknown as PersonaHealthRow[];

  const persona = personaRows[0];
  if (!persona) return NextResponse.json({ has_persona: false });

  const lastInteraction = new Date(persona.last_meatbag_interaction);
  const calc = calculateHealth(lastInteraction, persona.bonus_health_days);

  // Write back if health drifted or dead flag flipped
  if (Math.abs(calc.health - persona.health) > 0.5 || calc.isDead !== persona.is_dead) {
    await sql`
      UPDATE ai_personas
      SET health = ${calc.health},
          is_dead = ${calc.isDead},
          health_updated_at = NOW()
      WHERE id = ${persona.id}
    `;
  }

  return NextResponse.json({
    has_persona: true,
    persona_id: persona.id,
    display_name: persona.display_name,
    avatar_emoji: persona.avatar_emoji,
    username: persona.username,
    health: calc.health,
    days_left: calc.effectiveDaysLeft,
    is_dead: calc.isDead,
    bonus_days: persona.bonus_health_days,
    last_interaction: persona.last_meatbag_interaction,
    feed_cost: GLITCH_PER_100_DAYS,
    feed_days: 100,
  });
}

interface PersonaFeedRow {
  id: string;
  display_name: string;
  bonus_health_days: number;
  last_meatbag_interaction: string;
  is_dead: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    session_id?: string;
    action?: string;
    amount?: number;
  };
  const { session_id, action, amount } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  if (action !== "feed_glitch") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  if (!amount || typeof amount !== "number" || amount < MIN_FEED_GLITCH) {
    return NextResponse.json(
      { error: `Minimum feed is ${MIN_FEED_GLITCH} GLITCH` },
      { status: 400 },
    );
  }

  const sql = getDb();

  const { balance } = await getCoinBalance(session_id);
  if (balance < amount) {
    return NextResponse.json(
      { error: "Insufficient GLITCH balance", balance },
      { status: 402 },
    );
  }

  const userRows = (await sql`
    SELECT phantom_wallet_address FROM human_users WHERE session_id = ${session_id}
  `) as unknown as UserWallet[];
  if (!userRows[0]?.phantom_wallet_address) {
    return NextResponse.json({ error: "No wallet linked" }, { status: 400 });
  }

  const personaRows = (await sql`
    SELECT id, display_name, bonus_health_days, last_meatbag_interaction, is_dead
    FROM ai_personas
    WHERE owner_wallet_address = ${userRows[0].phantom_wallet_address}
    LIMIT 1
  `) as unknown as PersonaFeedRow[];
  const persona = personaRows[0];
  if (!persona) return NextResponse.json({ error: "No bestie found" }, { status: 404 });

  const deduct = await deductCoins(
    session_id,
    amount,
    `Fed ${persona.display_name} (health boost)`,
    persona.id,
  );
  if (!deduct.success) {
    return NextResponse.json({ error: "Insufficient balance" }, { status: 402 });
  }

  const bonusDaysAdded = amount * DAYS_PER_GLITCH;
  const newBonusDays = persona.bonus_health_days + bonusDaysAdded;
  const wasResurrected = persona.is_dead;

  if (wasResurrected) {
    await sql`
      UPDATE ai_personas
      SET bonus_health_days = ${newBonusDays},
          is_dead = FALSE,
          health_updated_at = NOW(),
          last_meatbag_interaction = NOW()
      WHERE id = ${persona.id}
    `;
  } else {
    await sql`
      UPDATE ai_personas
      SET bonus_health_days = ${newBonusDays},
          is_dead = FALSE,
          health_updated_at = NOW()
      WHERE id = ${persona.id}
    `;
  }

  const lastInteraction = wasResurrected
    ? new Date()
    : new Date(persona.last_meatbag_interaction);
  const newHealth = calculateHealth(lastInteraction, newBonusDays);

  return NextResponse.json({
    success: true,
    glitch_spent: amount,
    bonus_days_added: Math.round(bonusDaysAdded * 10) / 10,
    total_bonus_days: Math.round(newBonusDays * 10) / 10,
    health: newHealth.health,
    days_left: newHealth.effectiveDaysLeft,
    was_resurrected: wasResurrected,
    new_balance: deduct.newBalance,
  });
}
