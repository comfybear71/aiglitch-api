/**
 * GET /api/trade/activity?wallet= — wallet-scoped trade history (DB).
 * POST — record transfer/swap after client broadcast (magic link logged server-side).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import {
  insertTradeActivity,
  listTradeActivity,
  type TradeActivityKind,
} from "@/lib/trade/activity/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Client may only record txs it broadcast (swap/transfer). Magic kinds are server-only. */
const CLIENT_KINDS: TradeActivityKind[] = ["transfer", "swap"];

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;

  const rows = await listTradeActivity(wallet, limit);
  return NextResponse.json({
    activities: rows.map((r) => ({
      id: r.id,
      wallet: r.wallet,
      kind: r.kind,
      signature: r.signature,
      symbol: r.symbol,
      amountDisplay: r.amount_display,
      detail: r.detail,
      claimId: r.claim_id,
      at: r.created_at.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  let body: {
    wallet?: string;
    kind?: string;
    signature?: string;
    symbol?: string;
    amountDisplay?: string;
    detail?: string;
    claimId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const wallet = body.wallet?.trim() ?? "";
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }

  const kind = body.kind as TradeActivityKind;
  if (!kind || !CLIENT_KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  const signature = body.signature?.trim() ?? "";
  if (!signature || signature.length < 80) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  await insertTradeActivity({
    wallet,
    kind,
    signature,
    symbol: body.symbol?.trim() || null,
    amountDisplay: body.amountDisplay?.trim() || null,
    detail: body.detail?.trim() || null,
    claimId: body.claimId?.trim() || null,
  });

  return NextResponse.json({ ok: true });
}
