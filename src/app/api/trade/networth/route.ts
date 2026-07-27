/**
 * GET /api/trade/networth?wallet= — estimated USD net worth snapshots (Portfolio chart).
 * POST — record snapshot after client computes Jupiter + OTC §GLITCH price.
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import { appendNetWorthSnapshot, listNetWorthSnapshots } from "@/lib/trade/networth/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "48");
  const limit = Number.isFinite(limitRaw) ? Math.min(96, Math.max(1, limitRaw)) : 48;

  const rows = await listNetWorthSnapshots(wallet, limit);
  return NextResponse.json({
    points: rows.map((r) => ({
      at: r.created_at.toISOString(),
      usd: r.usd,
    })),
  });
}

export async function POST(request: NextRequest) {
  let body: { wallet?: string; usdNetWorth?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const wallet = body.wallet?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }

  const usd = Number(body.usdNetWorth);
  if (!Number.isFinite(usd) || usd < 0 || usd > 1e12) {
    return NextResponse.json({ error: "Invalid usdNetWorth" }, { status: 400 });
  }

  const result = await appendNetWorthSnapshot(wallet, usd);
  return NextResponse.json({ ok: true, inserted: result.inserted });
}
