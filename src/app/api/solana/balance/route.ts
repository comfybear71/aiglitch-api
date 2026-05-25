/**
 * GET /api/solana/balance — port of the legacy `?action=balance` branch.
 *
 * Shape parity: returns the exact same JSON the legacy
 * `aiglitch/src/app/api/solana/route.ts` returns for `action=balance`,
 * so flipping the strangler `beforeFiles` entry in the sister repo is
 * a no-op for consumers.
 *
 * Query params:
 *   wallet_address (required) — Phantom/Solana wallet public key
 *   session_id     (optional) — used to merge the user's app-side
 *                                §GLITCH balance from `glitch_coins`
 *
 * The response merges on-chain §GLITCH with the in-DB platform
 * balance via `Math.max(...)`. This mirrors legacy intent: show the
 * higher of the two so users don't see a regression when they connect
 * a wallet that hasn't yet received the on-chain airdrop.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  GLITCH_TOKEN_MINT_STR,
  hasValidTokenMint,
  isValidSolanaAddress,
} from "@/lib/solana-config";
import { getWalletBalances, heliusEnabled } from "@/lib/solana-balance";

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
    return NextResponse.json({
      real_mode: false,
      message: "Token mint not configured. Set NEXT_PUBLIC_GLITCH_TOKEN_MINT.",
    });
  }

  const balances = await getWalletBalances(walletAddress);

  let app_glitch_balance = 0;
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (sessionId) {
    try {
      const sql = getDb();
      const coins = await sql`SELECT balance FROM glitch_coins WHERE session_id = ${sessionId}`;
      if (coins.length > 0) app_glitch_balance = Number(coins[0].balance);
    } catch {
      // DB read is a best-effort overlay; on failure we keep app_glitch_balance = 0
      // so the on-chain numbers still surface.
    }
  }

  const onchain_glitch = balances.glitch_balance || 0;
  const effective_glitch = Math.max(onchain_glitch, app_glitch_balance);

  return NextResponse.json({
    real_mode: true,
    helius_enabled: heliusEnabled(),
    wallet_address: walletAddress,
    sol_balance: balances.sol_balance,
    glitch_balance: effective_glitch,
    onchain_glitch_balance: onchain_glitch,
    app_glitch_balance,
    budju_balance: balances.budju_balance,
    usdc_balance: balances.usdc_balance,
    token_mint: GLITCH_TOKEN_MINT_STR,
  });
}
