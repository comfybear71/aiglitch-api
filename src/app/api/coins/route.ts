import { type NextRequest, NextResponse } from "next/server";
import {
  claimSignupBonus,
  getCoinBalance,
  getTransactions,
} from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Actions migrated so far:
 *   Slice 1: GET (balance + lifetime + transactions)  ✅
 *   Slice 2: claim_signup                             ✅ this session
 *   Slice 3: send_to_persona, send_to_human           ⏳
 *   Slice 4: purchase_ad_free, check_ad_free          ⏳
 *   Slice 5: seed_personas, persona_balances          ⏳
 *
 * Unmigrated actions return 501 `action_not_yet_migrated`; consumers fall
 * through to the legacy backend via the strangler.
 */
const UNSUPPORTED_ACTIONS = new Set([
  "send_to_persona",
  "send_to_human",
  "purchase_ad_free",
  "check_ad_free",
  "seed_personas",
  "persona_balances",
]);

/**
 * GET /api/coins?session_id=X — GLITCH coin balance + recent transactions.
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
    console.error("[coins] GET error:", err);
    return NextResponse.json(
      {
        error: "Failed to load coins",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

interface PostBody {
  session_id?: string;
  action?: string;
}

/**
 * POST /api/coins — action-dispatched writes.
 *
 * `claim_signup` awards +100 GLITCH (the "Welcome bonus") once per session.
 * Legacy parity: on a duplicate claim, returns **200** (not 400/409) with
 * `{error: "Already claimed", already_claimed: true}`. Mid-migration
 * consumers expect that shape.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const { session_id, action } = body;

  if (!session_id || !action) {
    return NextResponse.json(
      { error: "Missing fields" },
      { status: 400 },
    );
  }

  if (action === "claim_signup") {
    try {
      const result = await claimSignupBonus(session_id);
      if (result.kind === "already_claimed") {
        return NextResponse.json({
          error: "Already claimed",
          already_claimed: true,
        });
      }
      return NextResponse.json({
        success: true,
        amount: result.amount,
        reason: "Welcome bonus",
      });
    } catch (err) {
      console.error("[coins] claim_signup error:", err);
      return NextResponse.json(
        {
          error: "Failed to claim signup bonus",
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  if (UNSUPPORTED_ACTIONS.has(action)) {
    return NextResponse.json(
      {
        error: "action_not_yet_migrated",
        action,
        note: "This /api/coins action lands in a later slice; use the legacy backend in the meantime.",
      },
      { status: 501 },
    );
  }

  return NextResponse.json(
    { error: "Invalid action", action },
    { status: 400 },
  );
}
