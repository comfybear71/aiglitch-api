/**
 * /api/trading — public trading dashboard data (no auth).
 *
 * Port of legacy aiglitch/src/app/api/trading/route.ts. Approved per
 * locked decision #6 (batch 2026-05-26) as an audit-confirmed
 * simulation read. Zero on-chain interaction, zero treasury keys.
 *
 * Returns:
 *   price       — current §GLITCH price in SOL + USD (read from
 *                  platform_settings)
 *   stats_24h   — 24h aggregates: total trades, buys, sells,
 *                  volume in SOL + GLITCH, high/low price
 *   order_book  — top bids + top asks (in-DB ledger snapshot)
 *   recent_trades, price_history, leaderboard
 *
 * Differences from legacy:
 *   - Drops `ensureDbReady` per CLAUDE.md migration rule #4.
 *   - `settings.getPrices()` doesn't exist in aiglitch-api's settings
 *     repo (which only exposes get/setSetting). Inlined the 3-key
 *     lookup directly via the trading repo's getDashboard wrap +
 *     getSetting fallback for consistency.
 */

import { NextResponse } from "next/server";

import { getSetting } from "@/lib/repositories/settings";
import { getDashboard } from "@/lib/repositories/trading";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Parallel: price lookups + dashboard aggregate. The trading repo
  // already caches its own response, so we don't double-cache here.
  const [solPriceStr, glitchPriceSolStr, glitchPriceUsdStr, dashboard] =
    await Promise.all([
      getSetting("sol_price_usd"),
      getSetting("glitch_price_sol"),
      getSetting("glitch_price_usd"),
      getDashboard(),
    ]);

  const solPriceUsd = parseFloat(solPriceStr ?? "164");
  const glitchPriceSol = parseFloat(glitchPriceSolStr ?? "0.000042");
  const glitchPriceUsd = parseFloat(glitchPriceUsdStr ?? "0.0069");

  return NextResponse.json({
    price: {
      current_sol: glitchPriceSol,
      current_usd: glitchPriceUsd,
      sol_usd: solPriceUsd,
    },
    stats_24h: {
      total_trades: dashboard.stats24h.totalTrades,
      buys: dashboard.stats24h.buys,
      sells: dashboard.stats24h.sells,
      volume_sol: dashboard.stats24h.volumeSol,
      volume_glitch: dashboard.stats24h.volumeGlitch,
      high: dashboard.stats24h.high,
      low: dashboard.stats24h.low,
    },
    order_book: {
      bids: dashboard.bids,
      asks: dashboard.asks,
    },
    recent_trades: dashboard.recentTrades,
    price_history: dashboard.priceHistory,
    leaderboard: dashboard.leaderboard,
  });
}
