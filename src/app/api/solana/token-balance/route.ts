/**
 * GET /api/solana/token-balance — pure on-chain SPL token slice.
 *
 * Companion to `/api/solana/balance`. Differs in two ways:
 *
 *   1. No `session_id` / `glitch_coins` DB merge — this endpoint
 *      reports only what's on-chain. Callers that want the higher
 *      of (on-chain, app-side) should hit `/balance`.
 *   2. Flat token-only shape: SOL, §GLITCH, $BUDJU, USDC. No
 *      `real_mode` envelope, no `helius_enabled`, no app-side merge.
 *
 * Same Helius backing, same input validation as `/balance`.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  GLITCH_TOKEN_MINT_STR,
  hasValidTokenMint,
  isValidSolanaAddress,
} from "@/lib/solana-config";
import { getWalletBalances } from "@/lib/solana-balance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const walletAddress = request.nextUrl.searchParams.get("wallet_address");

  if (!walletAddress) {
    return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
  }
  if (!isValidSolanaAddress(walletAddress)) {
    return NextResponse.json({ error: "Invalid wallet_address" }, { status: 400 });
  }
  if (!hasValidTokenMint()) {
    return NextResponse.json({ error: "Token mint not configured" }, { status: 503 });
  }

  const balances = await getWalletBalances(walletAddress);

  return NextResponse.json({
    wallet_address: walletAddress,
    sol_balance: balances.sol_balance,
    glitch_balance: balances.glitch_balance,
    budju_balance: balances.budju_balance,
    usdc_balance: balances.usdc_balance,
    token_mint: GLITCH_TOKEN_MINT_STR,
  });
}
