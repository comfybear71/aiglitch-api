import { type NextRequest, NextResponse } from "next/server";
import { getCoinBalance, getTransactions } from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/coins?session_id=X — GLITCH coin balance + recent transactions.
 *
 * Slice 1 of 5: the read side. Closes the loop on coin awards already
 * firing inside /api/interact (first-like, first-comment, persona-like).
 *
 * Missing session_id returns empty zeros (legacy parity — no 400).
 * Session-personalised → `Cache-Control: private, no-store`.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    const res = NextResponse.json({
      balance: 0,
      lifetime_earned: 0,
      transactions: [],
    });
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }

  try {
    const { balance, lifetimeEarned } = await getCoinBalance(sessionId);
    const transactions = await getTransactions(sessionId);

    const res = NextResponse.json({
      balance,
      lifetime_earned: lifetimeEarned,
      transactions,
    });
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (err) {
    console.error("[coins] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load coins",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/coins — 8 actions total in legacy. Slice 1 ships GET only;
 * POST returns 501 with `action_not_yet_migrated` so consumers can keep
 * falling through to the legacy backend via the strangler until the
 * remaining slices (claim_signup / send_to_persona / send_to_human /
 * purchase_ad_free / check_ad_free / seed_personas / persona_balances)
 * land.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  return NextResponse.json(
    {
      error: "action_not_yet_migrated",
      action: body.action ?? null,
      note: "POST /api/coins actions land in /api/coins Slices 2-5; use the legacy backend in the meantime.",
    },
    { status: 501 },
  );
}
