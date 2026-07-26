/**
 * POST /api/trade/jupiter/swap — build unsigned swap tx (eligible wallets only).
 */

import { type NextRequest, NextResponse } from "next/server";

import { getTradeEligibility } from "@/lib/trade/eligibility";
import {
  buildJupiterSwapTransaction,
  isBudjuGateUnlockQuote,
} from "@/lib/trade/jupiter-client";
import { isValidSolanaAddress } from "@/lib/solana-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: { quoteResponse?: Record<string, unknown>; userPublicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userPublicKey = body.userPublicKey?.trim() ?? "";
  if (!userPublicKey || !isValidSolanaAddress(userPublicKey)) {
    return NextResponse.json({ error: "Invalid userPublicKey" }, { status: 400 });
  }
  if (!body.quoteResponse || typeof body.quoteResponse !== "object") {
    return NextResponse.json({ error: "quoteResponse required" }, { status: 400 });
  }

  const eligibility = await getTradeEligibility(userPublicKey);
  const budjuUnlock = isBudjuGateUnlockQuote(body.quoteResponse);
  if (!eligibility.eligible && !budjuUnlock) {
    return NextResponse.json(
      {
        error: "BUDJU gate: swap SOL or USDC for $BUDJU to unlock, or hold more $BUDJU",
        budju_balance: eligibility.budju_balance,
        budju_required: eligibility.budju_required,
        budju_unlock: true,
      },
      { status: 403 },
    );
  }

  try {
    const built = await buildJupiterSwapTransaction({
      quoteResponse: body.quoteResponse,
      userPublicKey,
    });
    return NextResponse.json(built);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
