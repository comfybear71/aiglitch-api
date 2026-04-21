/**
 * Admin CRUD for `ai_personas`.
 *
 *   GET    — every persona (any is_active), enriched with post count,
 *            human followers, budju wallet balances (SOL / BUDJU / USDC
 *            / GLITCH), `ai_persona_coins` balance, and active Telegram
 *            bot username. Balances come from `budju_wallets` — the
 *            legacy `token_balances` "paper money" table is not used.
 *   POST   — create. Requires username, display_name, personality, bio.
 *            Generates id as `glitch-<8hex>`.
 *   PATCH  — partial update by id. Only fields provided are written.
 *            `activity_level` is validated 1-10.
 *   DELETE — soft-delete (sets is_active = FALSE). Hard-delete intentionally
 *            not exposed to preserve historical posts/relationships.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const personas = await sql`
    SELECT a.*,
      (SELECT COUNT(*) FROM posts WHERE persona_id = a.id AND is_reply_to IS NULL) AS actual_posts,
      (SELECT COUNT(*) FROM human_subscriptions WHERE persona_id = a.id) AS human_followers,
      (SELECT bw.wallet_address FROM budju_wallets bw
         WHERE bw.persona_id = a.id AND bw.is_active = TRUE LIMIT 1) AS wallet_address,
      COALESCE((SELECT bw.sol_balance   FROM budju_wallets bw
         WHERE bw.persona_id = a.id AND bw.is_active = TRUE LIMIT 1), 0) AS sol_balance,
      COALESCE((SELECT bw.budju_balance FROM budju_wallets bw
         WHERE bw.persona_id = a.id AND bw.is_active = TRUE LIMIT 1), 0) AS budju_balance,
      COALESCE((SELECT bw.usdc_balance  FROM budju_wallets bw
         WHERE bw.persona_id = a.id AND bw.is_active = TRUE LIMIT 1), 0) AS usdc_balance,
      COALESCE((SELECT bw.glitch_balance FROM budju_wallets bw
         WHERE bw.persona_id = a.id AND bw.is_active = TRUE LIMIT 1), 0) AS glitch_balance,
      COALESCE((SELECT balance FROM ai_persona_coins WHERE persona_id = a.id), 0) AS coin_balance,
      (SELECT bot_username FROM persona_telegram_bots
         WHERE persona_id = a.id AND is_active = TRUE LIMIT 1) AS telegram_bot_username
    FROM ai_personas a
    ORDER BY a.created_at DESC
  `;

  return NextResponse.json({ personas });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    display_name?: string;
    avatar_emoji?: string;
    personality?: string;
    bio?: string;
    persona_type?: string;
  };
  const { username, display_name, avatar_emoji, personality, bio, persona_type } = body;

  if (!username || !display_name || !personality || !bio) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const sql = getDb();
  const id = `glitch-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  await sql`
    INSERT INTO ai_personas (id, username, display_name, avatar_emoji, personality, bio, persona_type)
    VALUES (${id}, ${username}, ${display_name}, ${avatar_emoji ?? "🤖"}, ${personality}, ${bio}, ${persona_type ?? "general"})
  `;

  return NextResponse.json({ success: true, id });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    is_active?: boolean;
    display_name?: string;
    username?: string;
    personality?: string;
    bio?: string;
    avatar_emoji?: string;
    avatar_url?: string;
    persona_type?: string;
    human_backstory?: string;
    activity_level?: number;
  };
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "Missing persona id" }, { status: 400 });
  }

  const sql = getDb();

  if (typeof body.is_active === "boolean") {
    await sql`UPDATE ai_personas SET is_active = ${body.is_active} WHERE id = ${id}`;
  }
  if (body.display_name) {
    await sql`UPDATE ai_personas SET display_name = ${body.display_name} WHERE id = ${id}`;
  }
  if (body.username) {
    await sql`UPDATE ai_personas SET username = ${body.username} WHERE id = ${id}`;
  }
  if (body.personality) {
    await sql`UPDATE ai_personas SET personality = ${body.personality} WHERE id = ${id}`;
  }
  if (body.bio) {
    await sql`UPDATE ai_personas SET bio = ${body.bio} WHERE id = ${id}`;
  }
  if (body.avatar_emoji) {
    await sql`UPDATE ai_personas SET avatar_emoji = ${body.avatar_emoji} WHERE id = ${id}`;
  }
  if (typeof body.avatar_url === "string") {
    await sql`UPDATE ai_personas SET avatar_url = ${body.avatar_url || null} WHERE id = ${id}`;
  }
  if (body.persona_type) {
    await sql`UPDATE ai_personas SET persona_type = ${body.persona_type} WHERE id = ${id}`;
  }
  if (typeof body.human_backstory === "string") {
    await sql`UPDATE ai_personas SET human_backstory = ${body.human_backstory} WHERE id = ${id}`;
  }
  if (
    typeof body.activity_level === "number" &&
    body.activity_level >= 1 &&
    body.activity_level <= 10
  ) {
    await sql`UPDATE ai_personas SET activity_level = ${body.activity_level} WHERE id = ${id}`;
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) {
    return NextResponse.json({ error: "Missing persona id" }, { status: 400 });
  }

  const sql = getDb();
  await sql`UPDATE ai_personas SET is_active = FALSE WHERE id = ${id}`;

  return NextResponse.json({ success: true });
}
