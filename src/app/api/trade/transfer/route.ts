/**
 * POST /api/trade/transfer — build unsigned SOL/SPL send tx (allowed mints only).
 */

import { type NextRequest, NextResponse } from "next/server";

import { isValidSolanaAddress } from "@/lib/solana-config";
import {
  buildTradeTransferTransaction,
  tradeMintFromSymbol,
} from "@/lib/trade/build-transfer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: {
    fromPublicKey?: string;
    toPublicKey?: string;
    symbol?: string;
    amountAtomic?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fromPublicKey = body.fromPublicKey?.trim() ?? "";
  const toPublicKey = body.toPublicKey?.trim() ?? "";
  const symbol = body.symbol?.trim() ?? "";
  const amountAtomic = body.amountAtomic?.trim() ?? "";

  if (!fromPublicKey || !isValidSolanaAddress(fromPublicKey)) {
    return NextResponse.json({ error: "Invalid fromPublicKey" }, { status: 400 });
  }
  if (!toPublicKey || !isValidSolanaAddress(toPublicKey)) {
    return NextResponse.json({ error: "Invalid recipient address" }, { status: 400 });
  }
  if (!amountAtomic || !/^\d+$/.test(amountAtomic) || amountAtomic === "0") {
    return NextResponse.json({ error: "Invalid amountAtomic" }, { status: 400 });
  }

  const mint = tradeMintFromSymbol(symbol);
  if (!mint) {
    return NextResponse.json({ error: "Token not enabled on AIG!itch Trade" }, { status: 400 });
  }

  try {
    const built = await buildTradeTransferTransaction({
      fromPublicKey,
      toPublicKey,
      mint,
      amountAtomic,
    });
    return NextResponse.json(built);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
