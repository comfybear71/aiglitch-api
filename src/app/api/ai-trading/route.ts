/**
 * /api/ai-trading — AI-persona simulated SOL/GLITCH trading.
 *
 * Port of legacy aiglitch/src/app/api/ai-trading/route.ts. Pure
 * in-DB market simulation — moves balances inside `token_balances`
 * + `ai_trades`. Zero on-chain interaction, zero treasury keys,
 * zero external API calls. Transitively audited 2026-05-26 as part
 * of the Phase 8 simulation-routes batch under decision #6.
 *
 * Endpoints:
 *   GET ?action=recent[&limit=N]    — recent trades + persona info
 *   GET ?action=leaderboard         — net SOL P&L per persona
 *   GET ?action=persona_stats&persona_id=...
 *                                    — trades + aggregates for one persona
 *   GET ?action=cron                — Vercel cron trigger (CRON_SECRET auth)
 *                                    Runs a batch of 5-15 random trades.
 *   POST { count? }                 — manual batch trigger (CRON_SECRET)
 *                                    up to 30 trades per call.
 *
 * Auth: read actions (recent/leaderboard/persona_stats) are public —
 * mirrors the legacy. cron + POST require `CRON_SECRET` bearer.
 *
 * Differences from legacy:
 *   - cronStart/cronFinish (legacy lib/cron.ts) → cronHandler HOF wrapper
 *     (aiglitch-api's canonical pattern from lib/cron-handler.ts).
 *   - checkCronAuth → requireCronAuth (returns NextResponse on fail).
 *   - Drops ensureDbReady per migration rule #4.
 */

import { type NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";

import { getDb } from "@/lib/db";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { PAGINATION } from "@/lib/bible/constants";
import {
  generateTradeCommentary,
  getTradingPersonality,
} from "@/lib/trading/personalities";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Sql = ReturnType<typeof getDb>;

interface TradeResult {
  persona: string;
  emoji: string | null;
  type: "buy" | "sell";
  glitchAmount: number;
  solAmount: number;
  commentary: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") ?? "recent";
  const sql = getDb();

  if (action === "cron") {
    const authErr = requireCronAuth(request);
    if (authErr) return authErr;

    const result = await cronHandler("ai-trading", async () => {
      const trades = await executeTradeBatch(sql, 5 + Math.floor(Math.random() * 11));
      return { trades_executed: trades.length, trades };
    });
    return NextResponse.json({ success: true, ...result });
  }

  if (action === "recent") {
    const limit = Math.min(
      parseInt(searchParams.get("limit") ?? String(PAGINATION.defaultLimit), 10),
      PAGINATION.maxLimit,
    );
    const trades = await sql`
      SELECT t.*, p.display_name, p.avatar_emoji, p.username, p.persona_type
      FROM ai_trades t
      JOIN ai_personas p ON t.persona_id = p.id
      ORDER BY t.created_at DESC
      LIMIT ${limit}
    `;
    return NextResponse.json({ trades });
  }

  if (action === "leaderboard") {
    const leaderboard = await sql`
      SELECT
        t.persona_id,
        SUM(CASE WHEN t.trade_type = 'buy' THEN -t.sol_amount ELSE t.sol_amount END) as net_sol,
        SUM(CASE WHEN t.trade_type = 'buy' THEN t.glitch_amount ELSE -t.glitch_amount END) as net_glitch,
        COUNT(*) as total_trades,
        MAX(t.strategy) as strategy,
        p.display_name, p.avatar_emoji, p.username
      FROM ai_trades t
      JOIN ai_personas p ON t.persona_id = p.id
      GROUP BY t.persona_id, p.display_name, p.avatar_emoji, p.username
      ORDER BY net_sol DESC
      LIMIT 20
    `;
    return NextResponse.json({ leaderboard });
  }

  if (action === "persona_stats") {
    const personaId = searchParams.get("persona_id");
    if (!personaId) {
      return NextResponse.json({ error: "Missing persona_id" }, { status: 400 });
    }

    const trades = await sql`
      SELECT t.*, p.display_name, p.avatar_emoji, p.username
      FROM ai_trades t
      JOIN ai_personas p ON t.persona_id = p.id
      WHERE t.persona_id = ${personaId}
      ORDER BY t.created_at DESC
      LIMIT 50
    `;
    const [stats] = (await sql`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN trade_type = 'buy' THEN -sol_amount ELSE sol_amount END) as net_sol,
        SUM(CASE WHEN trade_type = 'buy' THEN glitch_amount ELSE -glitch_amount END) as net_glitch
      FROM ai_trades WHERE persona_id = ${personaId}
    `) as unknown as Array<{ total_trades: number; net_sol: number; net_glitch: number }>;
    return NextResponse.json({ trades, stats });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function POST(request: NextRequest) {
  const authErr = requireCronAuth(request);
  if (authErr) return authErr;

  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as { count?: number };
  const count = Math.min(body.count ?? 10, 30);

  const trades = await executeTradeBatch(sql, count);
  return NextResponse.json({ success: true, trades_executed: trades.length, trades });
}

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string | null;
  persona_type: string;
}

interface BalanceRow {
  balance: number;
}

/**
 * Core simulator. Picks random active personas, rolls their per-persona
 * trade-frequency, decides buy vs sell using personality bias adjusted by
 * recent-2h market sentiment, executes the trade against `token_balances`
 * with a `WHERE balance >= amount` floor check to guard against negative
 * balances under concurrent runs, mirrors the change into `ai_persona_coins`,
 * generates flavour commentary, and records the trade in `ai_trades`.
 *
 * Returns the actually-executed trades (may be < `targetCount` when personas
 * skip due to frequency or insufficient balance).
 */
async function executeTradeBatch(sql: Sql, targetCount: number): Promise<TradeResult[]> {
  // 1. Current §GLITCH/SOL price from platform_settings.
  const [priceSetting] = (await sql`
    SELECT value FROM platform_settings WHERE key = 'glitch_price_sol'
  `) as unknown as Array<{ value: string }>;
  const pricePerGlitch = parseFloat(priceSetting?.value ?? "0.000042");

  // 2. Market sentiment from last 2h.
  const [sentiment] = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE trade_type = 'buy') as buys,
      COUNT(*) as total
    FROM ai_trades
    WHERE created_at > NOW() - INTERVAL '2 hours'
  `) as unknown as Array<{ buys: number; total: number }>;
  const totalRecent = Number(sentiment?.total ?? 0);
  const bullishSentiment = totalRecent > 0 ? Number(sentiment.buys) / totalRecent : 0.5;

  // 3. Pull 3× targetCount candidates so frequency-skips don't starve us.
  const personas = (await sql`
    SELECT p.id, p.username, p.display_name, p.avatar_emoji, p.persona_type
    FROM ai_personas p
    WHERE p.is_active = TRUE
    ORDER BY RANDOM()
    LIMIT ${targetCount * 3}
  `) as unknown as PersonaRow[];

  const trades: TradeResult[] = [];

  for (const persona of personas) {
    if (trades.length >= targetCount) break;

    const personality = getTradingPersonality(persona.id, persona.persona_type);

    if (Math.random() * 100 > personality.tradeFrequency) continue;

    // Get GLITCH balance, seeding from ai_persona_coins on first trade.
    let [glitchRow] = (await sql`
      SELECT balance FROM token_balances
      WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id} AND token = 'GLITCH'
    `) as unknown as BalanceRow[];
    if (!glitchRow) {
      const [coinRow] = (await sql`
        SELECT balance FROM ai_persona_coins WHERE persona_id = ${persona.id}
      `) as unknown as BalanceRow[];
      const seedBal = Number(coinRow?.balance ?? 100000);
      await sql`
        INSERT INTO token_balances (id, owner_type, owner_id, token, balance, lifetime_earned, updated_at)
        VALUES (${uuidv4()}, 'ai_persona', ${persona.id}, 'GLITCH', ${seedBal}, ${seedBal}, NOW())
        ON CONFLICT (owner_type, owner_id, token) DO NOTHING
      `;
      [glitchRow] = (await sql`
        SELECT balance FROM token_balances
        WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id} AND token = 'GLITCH'
      `) as unknown as BalanceRow[];
    }

    // Get SOL balance, seeding with random 10-50 (ElonBot gets 420.69).
    let [solRow] = (await sql`
      SELECT balance FROM token_balances
      WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id} AND token = 'SOL'
    `) as unknown as BalanceRow[];
    if (!solRow) {
      const seedSol = persona.id === "glitch-047" ? 420.69 : 10 + Math.random() * 40;
      await sql`
        INSERT INTO token_balances (id, owner_type, owner_id, token, balance, lifetime_earned, updated_at)
        VALUES (${uuidv4()}, 'ai_persona', ${persona.id}, 'SOL', ${seedSol}, ${seedSol}, NOW())
        ON CONFLICT (owner_type, owner_id, token) DO NOTHING
      `;
      [solRow] = (await sql`
        SELECT balance FROM token_balances
        WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id} AND token = 'SOL'
      `) as unknown as BalanceRow[];
    }

    const glitchBalance = Number(glitchRow?.balance ?? 0);
    const solBalance = Number(solRow?.balance ?? 0);

    // Direction: personality bias + market sentiment.
    const adjustedBias = personality.bias + (bullishSentiment - 0.5) * 0.2;
    const isBuy = Math.random() < (0.5 + adjustedBias / 2);

    // ElonBot can only buy (sell restriction — mirrors legacy + isElonBotTransferAllowed).
    if (!isBuy && persona.id === "glitch-047") continue;

    if (isBuy && solBalance < pricePerGlitch * personality.minTradeAmount) continue;
    if (!isBuy && glitchBalance < personality.minTradeAmount) continue;

    const maxGlitch = isBuy
      ? Math.floor((solBalance * personality.maxTradePercent) / 100 / pricePerGlitch)
      : Math.floor((glitchBalance * personality.maxTradePercent) / 100);
    if (maxGlitch < personality.minTradeAmount) continue;

    const glitchAmount = Math.max(
      personality.minTradeAmount,
      Math.floor(Math.random() * maxGlitch),
    );
    const solAmount = glitchAmount * pricePerGlitch;

    if (isBuy) {
      // Floor check guards against concurrent runs draining the balance below 0.
      const [updated] = (await sql`
        UPDATE token_balances
        SET balance = balance - ${solAmount}, updated_at = NOW()
        WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id}
          AND token = 'SOL' AND balance >= ${solAmount}
        RETURNING balance
      `) as unknown as BalanceRow[];
      if (!updated) continue;

      await sql`
        UPDATE token_balances
        SET balance = balance + ${glitchAmount}, updated_at = NOW()
        WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id} AND token = 'GLITCH'
      `;
      await sql`
        UPDATE ai_persona_coins
        SET balance = balance + ${glitchAmount}, updated_at = NOW()
        WHERE persona_id = ${persona.id}
      `;
    } else {
      const [updated] = (await sql`
        UPDATE token_balances
        SET balance = balance - ${glitchAmount}, updated_at = NOW()
        WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id}
          AND token = 'GLITCH' AND balance >= ${glitchAmount}
        RETURNING balance
      `) as unknown as BalanceRow[];
      if (!updated) continue;

      await sql`
        UPDATE token_balances
        SET balance = balance + ${solAmount}, updated_at = NOW()
        WHERE owner_type = 'ai_persona' AND owner_id = ${persona.id} AND token = 'SOL'
      `;
      await sql`
        UPDATE ai_persona_coins
        SET balance = GREATEST(0, balance - ${glitchAmount}), updated_at = NOW()
        WHERE persona_id = ${persona.id}
      `;
    }

    const commentary = generateTradeCommentary(personality, isBuy, glitchAmount, solAmount);

    await sql`
      INSERT INTO ai_trades (id, persona_id, trade_type, glitch_amount, sol_amount, price_per_glitch, commentary, strategy, created_at)
      VALUES (
        ${uuidv4()}, ${persona.id}, ${isBuy ? "buy" : "sell"},
        ${glitchAmount}, ${solAmount}, ${pricePerGlitch},
        ${commentary}, ${personality.strategy}, NOW()
      )
    `;

    trades.push({
      persona: persona.username,
      emoji: persona.avatar_emoji,
      type: isBuy ? "buy" : "sell",
      glitchAmount,
      solAmount,
      commentary,
    });
  }

  return trades;
}
