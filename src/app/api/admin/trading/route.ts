/**
 * GET /api/admin/trading?action=dashboard
 *   Read-only trading dashboard: current price, 24h aggregate stats,
 *   order book depth, recent trades, hourly price candles (7d),
 *   leaderboard, per-persona holdings.
 *
 * POST /api/admin/trading { action: "trigger_trades", count? }
 *   Intentionally NOT ported. Would forward to `/api/ai-trading`, which
 *   is locked under Phase 8 (CLAUDE.md decision #6 — requires written
 *   confirmation per endpoint). Returns 501 so the admin UI can render
 *   "trading endpoint not yet migrated".
 *
 * Scope is admin MONITORING only — reads from `ai_trades`,
 * `token_balances`, and `platform_settings`. The actual trading engine
 * lives behind locked endpoints that stay on the legacy backend until
 * Phase 8 ships.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PriceSetting { value: string }

interface TradeRow {
  id: string;
  trade_type: string;
  glitch_amount: number;
  sol_amount: number;
  price_per_glitch: number;
  commentary: string | null;
  strategy: string | null;
  created_at: string;
  display_name: string;
  avatar_emoji: string;
  username: string;
}

interface OrderBookRow {
  price: number;
  total_glitch: number | string;
  total_sol: number | string;
  order_count: number | string;
}

interface StatsRow {
  total_trades: number | string;
  buys: number | string;
  sells: number | string;
  total_volume_sol: number | string;
  total_volume_glitch: number | string;
  avg_price: number | string;
  high_price: number | string;
  low_price: number | string;
}

interface CandleRow {
  time_bucket: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
  trade_count: number | string;
}

async function safeRows<T>(fn: () => Promise<T[]>): Promise<T[]> {
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
  const action = request.nextUrl.searchParams.get("action") || "dashboard";

  if (action !== "dashboard") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const priceSol = await safeRows<PriceSetting>(() =>
    sql`SELECT value FROM platform_settings WHERE key = 'glitch_price_sol'` as unknown as Promise<PriceSetting[]>,
  );
  const priceUsd = await safeRows<PriceSetting>(() =>
    sql`SELECT value FROM platform_settings WHERE key = 'glitch_price_usd'` as unknown as Promise<PriceSetting[]>,
  );
  const solPrice = await safeRows<PriceSetting>(() =>
    sql`SELECT value FROM platform_settings WHERE key = 'sol_price_usd'` as unknown as Promise<PriceSetting[]>,
  );

  const currentPrice = parseFloat(priceSol[0]?.value ?? "0.000042");
  const currentPriceUsd = parseFloat(priceUsd[0]?.value ?? "0.0069");
  const solPriceUsd = parseFloat(solPrice[0]?.value ?? "164");

  const [recentTrades, buyOrders, sellOrders, stats24hRows, priceHistory, leaderboard, holdings] = await Promise.all([
    safeRows<TradeRow>(() => sql`
      SELECT t.id, t.trade_type, t.glitch_amount, t.sol_amount, t.price_per_glitch,
             t.commentary, t.strategy, t.created_at,
             p.display_name, p.avatar_emoji, p.username
      FROM ai_trades t
      JOIN ai_personas p ON t.persona_id = p.id
      ORDER BY t.created_at DESC
      LIMIT 50
    ` as unknown as Promise<TradeRow[]>),

    safeRows<OrderBookRow>(() => sql`
      SELECT
        ROUND(price_per_glitch::numeric, 8) AS price,
        SUM(glitch_amount)                  AS total_glitch,
        SUM(sol_amount)                     AS total_sol,
        COUNT(*)                            AS order_count
      FROM ai_trades
      WHERE trade_type = 'buy' AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY ROUND(price_per_glitch::numeric, 8)
      ORDER BY price DESC
      LIMIT 15
    ` as unknown as Promise<OrderBookRow[]>),

    safeRows<OrderBookRow>(() => sql`
      SELECT
        ROUND(price_per_glitch::numeric, 8) AS price,
        SUM(glitch_amount)                  AS total_glitch,
        SUM(sol_amount)                     AS total_sol,
        COUNT(*)                            AS order_count
      FROM ai_trades
      WHERE trade_type = 'sell' AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY ROUND(price_per_glitch::numeric, 8)
      ORDER BY price ASC
      LIMIT 15
    ` as unknown as Promise<OrderBookRow[]>),

    safeRows<StatsRow>(() => sql`
      SELECT
        COUNT(*)                                        AS total_trades,
        COUNT(*) FILTER (WHERE trade_type = 'buy')      AS buys,
        COUNT(*) FILTER (WHERE trade_type = 'sell')     AS sells,
        COALESCE(SUM(sol_amount), 0)                    AS total_volume_sol,
        COALESCE(SUM(glitch_amount), 0)                 AS total_volume_glitch,
        COALESCE(AVG(price_per_glitch), 0)              AS avg_price,
        COALESCE(MAX(price_per_glitch), 0)              AS high_price,
        COALESCE(MIN(price_per_glitch), 0)              AS low_price
      FROM ai_trades
      WHERE created_at > NOW() - INTERVAL '24 hours'
    ` as unknown as Promise<StatsRow[]>),

    safeRows<CandleRow>(() => sql`
      SELECT
        date_trunc('hour', created_at)                        AS time_bucket,
        (array_agg(price_per_glitch ORDER BY created_at ASC))[1]  AS open,
        MAX(price_per_glitch)                                 AS high,
        MIN(price_per_glitch)                                 AS low,
        (array_agg(price_per_glitch ORDER BY created_at DESC))[1] AS close,
        SUM(glitch_amount)                                    AS volume,
        COUNT(*)                                              AS trade_count
      FROM ai_trades
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY date_trunc('hour', created_at)
      ORDER BY time_bucket ASC
    ` as unknown as Promise<CandleRow[]>),

    safeRows<unknown>(() => sql`
      SELECT
        t.persona_id,
        p.display_name, p.avatar_emoji, p.username,
        COUNT(*)                                                               AS total_trades,
        SUM(CASE WHEN t.trade_type = 'buy'  THEN t.glitch_amount ELSE 0 END)   AS total_bought,
        SUM(CASE WHEN t.trade_type = 'sell' THEN t.glitch_amount ELSE 0 END)   AS total_sold,
        SUM(CASE WHEN t.trade_type = 'buy'  THEN -t.sol_amount ELSE t.sol_amount END)     AS net_sol,
        SUM(CASE WHEN t.trade_type = 'buy'  THEN t.glitch_amount ELSE -t.glitch_amount END) AS net_glitch,
        MAX(t.strategy)                                                        AS strategy
      FROM ai_trades t
      JOIN ai_personas p ON t.persona_id = p.id
      GROUP BY t.persona_id, p.display_name, p.avatar_emoji, p.username
      ORDER BY net_sol DESC
      LIMIT 20
    ` as unknown as Promise<unknown[]>),

    safeRows<unknown>(() => sql`
      SELECT
        tb.owner_id AS persona_id,
        p.display_name, p.avatar_emoji, p.username,
        MAX(CASE WHEN tb.token = 'GLITCH' THEN tb.balance ELSE 0 END) AS glitch_balance,
        MAX(CASE WHEN tb.token = 'SOL'    THEN tb.balance ELSE 0 END) AS sol_balance
      FROM token_balances tb
      JOIN ai_personas p ON tb.owner_id = p.id
      WHERE tb.owner_type = 'ai_persona' AND tb.token IN ('GLITCH', 'SOL')
      GROUP BY tb.owner_id, p.display_name, p.avatar_emoji, p.username
      ORDER BY MAX(CASE WHEN tb.token = 'GLITCH' THEN tb.balance ELSE 0 END) DESC
      LIMIT 25
    ` as unknown as Promise<unknown[]>),
  ]);

  const stats = stats24hRows[0] ?? {
    total_trades: 0, buys: 0, sells: 0,
    total_volume_sol: 0, total_volume_glitch: 0,
    avg_price: 0, high_price: 0, low_price: 0,
  };

  return NextResponse.json({
    price: {
      current_sol: currentPrice,
      current_usd: currentPriceUsd,
      sol_usd:     solPriceUsd,
    },
    stats_24h: {
      total_trades:  Number(stats.total_trades),
      buys:          Number(stats.buys),
      sells:         Number(stats.sells),
      volume_sol:    Number(stats.total_volume_sol),
      volume_glitch: Number(stats.total_volume_glitch),
      avg_price:     Number(stats.avg_price),
      high:          Number(stats.high_price),
      low:           Number(stats.low_price),
    },
    order_book: {
      bids: buyOrders.map((o) => ({
        price:  Number(o.price),
        amount: Number(o.total_glitch),
        total:  Number(o.total_sol),
        count:  Number(o.order_count),
      })),
      asks: sellOrders.map((o) => ({
        price:  Number(o.price),
        amount: Number(o.total_glitch),
        total:  Number(o.total_sol),
        count:  Number(o.order_count),
      })),
    },
    recent_trades: recentTrades,
    price_history: priceHistory.map((p) => ({
      time:   p.time_bucket,
      open:   Number(p.open),
      high:   Number(p.high),
      low:    Number(p.low),
      close:  Number(p.close),
      volume: Number(p.volume),
      trades: Number(p.trade_count),
    })),
    leaderboard,
    holdings,
  });
}

/**
 * POST trigger_trades forwards to /api/ai-trading, which is locked under
 * Phase 8. Return 501 with a clear note so the admin UI can render a
 * disabled state rather than a silent failure.
 */
export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      error: "Trigger not yet migrated",
      detail:
        "POST /api/admin/trading forwards to /api/ai-trading, which is locked under Phase 8 (trading endpoints require explicit written confirmation per CLAUDE.md decision #6).",
      migrated: false,
    },
    { status: 501 },
  );
}
