/**
 * GET /api/trade/tokens/meta — icons + names for trade-lane tokens.
 * Query: symbols=JUP,SOL (optional; default all allowlisted)
 */

import { type NextRequest, NextResponse } from "next/server";

import { TRADE_ALL_TOKEN_DEFS } from "@/lib/trade/curated-markets";
import {
  resolveAllTradeTokenMeta,
  resolveTradeTokenMetaForSymbols,
} from "@/lib/trade/token-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("symbols")?.trim();
  try {
    const tokens = raw
      ? await resolveTradeTokenMetaForSymbols(
          raw.split(",").map((s) => s.trim()).filter(Boolean),
        )
      : await resolveAllTradeTokenMeta();

    return NextResponse.json({
      tokens,
      allowlist: TRADE_ALL_TOKEN_DEFS.map((t) => t.symbol),
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
