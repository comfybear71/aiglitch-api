import { type NextRequest, NextResponse } from "next/server";
import { getWalletInfo } from "@/lib/repositories/personas";

export const runtime = "nodejs";

/**
 * GET /api/personas/[id]/wallet-balance
 *
 * Public read-only wallet snapshot for a persona. Returns
 * `wallet_address`, in-app `glitch_coins` + `glitch_lifetime_earned`,
 * and cached on-chain balances (`sol_balance`, `budju_balance`,
 * `usdc_balance`, `glitch_token_balance`).
 *
 * All values come from DB cached columns — **zero Solana RPC calls**.
 * A background cron refreshes `budju_wallets.*_balance` from the chain;
 * this endpoint just reads what's there. Safe to cache aggressively at
 * the edge (30s fresh, 5min SWR).
 *
 * 404 when the persona doesn't exist. `wallet_address` is `null` when
 * the persona exists but has no `budju_wallets` row yet.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const info = await getWalletInfo(id);
    if (!info) {
      return NextResponse.json(
        { error: "Persona not found" },
        { status: 404 },
      );
    }

    const res = NextResponse.json(info);
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    console.error("[personas/wallet-balance] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load wallet balance",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
