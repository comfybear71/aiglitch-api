import { type NextRequest, NextResponse } from "next/server";
import {
  MAX_TRANSFER,
  awardCoins,
  awardPersonaCoins,
  claimSignupBonus,
  deductCoins,
  getCoinBalance,
  getTransactions,
  getUserByUsername,
} from "@/lib/repositories/users";
import { getIdAndDisplayName } from "@/lib/repositories/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Actions migrated so far:
 *   Slice 1: GET (balance + lifetime + transactions)            ✅
 *   Slice 2: claim_signup                                       ✅
 *   Slice 3: send_to_persona, send_to_human                     ✅ this session
 *   Slice 4: purchase_ad_free, check_ad_free                    ⏳
 *   Slice 5: seed_personas, persona_balances                    ⏳
 *
 * Unmigrated actions return 501 `action_not_yet_migrated`; consumers fall
 * through to the legacy backend via the strangler.
 */
const UNSUPPORTED_ACTIONS = new Set([
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
  persona_id?: string;
  friend_username?: string;
  amount?: number;
}

/**
 * POST /api/coins — action-dispatched writes.
 *
 * Slice 3 adds the two transfer actions:
 *   - `send_to_persona`: session → AI persona. Debits `glitch_coins`,
 *     credits `ai_persona_coins`.
 *   - `send_to_human`: session → another human (by username). Debits
 *     sender's `glitch_coins`, credits recipient's.
 *
 * Legacy-parity error contract:
 *   - 400 Invalid amount (missing/non-number/<1/exceeds cap)
 *   - 402 Insufficient balance (body carries `balance` + `shortfall`)
 *   - 404 Persona not found / User not found
 *   - 400 Cannot send coins to yourself (send_to_human only)
 *
 * Non-transactional by design (legacy parity): debit and credit are two
 * SQL operations. If the credit fails after the debit succeeds, coins
 * are lost — matches legacy behavior. Transfers aren't a hot path.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const { session_id, action } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
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

  if (action === "send_to_persona") {
    return handleSendToPersona(session_id, body);
  }

  if (action === "send_to_human") {
    return handleSendToHuman(session_id, body);
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

function validateTransferAmount(amount: unknown): NextResponse | null {
  if (!amount || typeof amount !== "number" || amount < 1) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  if (amount > MAX_TRANSFER) {
    return NextResponse.json(
      { error: `Max transfer is §${MAX_TRANSFER.toLocaleString()}` },
      { status: 400 },
    );
  }
  return null;
}

async function handleSendToPersona(
  sessionId: string,
  body: PostBody,
): Promise<NextResponse> {
  const { persona_id, amount } = body;

  if (!persona_id) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  const amountCheck = validateTransferAmount(amount);
  if (amountCheck) return amountCheck;

  try {
    const { balance } = await getCoinBalance(sessionId);
    if (balance < (amount as number)) {
      return NextResponse.json(
        {
          error: "Insufficient balance",
          balance,
          shortfall: (amount as number) - balance,
        },
        { status: 402 },
      );
    }

    const persona = await getIdAndDisplayName(persona_id);
    if (!persona) {
      return NextResponse.json(
        { error: "Persona not found" },
        { status: 404 },
      );
    }

    const deductResult = await deductCoins(
      sessionId,
      amount as number,
      `Sent to ${persona.display_name}`,
      persona.id,
    );
    if (!deductResult.success) {
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 402 },
      );
    }
    await awardPersonaCoins(persona.id, amount as number);

    return NextResponse.json({
      success: true,
      sent: amount,
      recipient: persona.display_name,
      new_balance: deductResult.newBalance,
    });
  } catch (err) {
    console.error("[coins] send_to_persona error:", err);
    return NextResponse.json(
      {
        error: "Failed to send coins",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

async function handleSendToHuman(
  sessionId: string,
  body: PostBody,
): Promise<NextResponse> {
  const { friend_username, amount } = body;

  if (!friend_username) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  const amountCheck = validateTransferAmount(amount);
  if (amountCheck) return amountCheck;

  try {
    const { balance } = await getCoinBalance(sessionId);
    if (balance < (amount as number)) {
      return NextResponse.json(
        {
          error: "Insufficient balance",
          balance,
          shortfall: (amount as number) - balance,
        },
        { status: 402 },
      );
    }

    const recipient = await getUserByUsername(friend_username);
    if (!recipient) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (recipient.session_id === sessionId) {
      return NextResponse.json(
        { error: "Cannot send coins to yourself" },
        { status: 400 },
      );
    }

    const deductResult = await deductCoins(
      sessionId,
      amount as number,
      `Sent to ${recipient.display_name}`,
      recipient.session_id,
    );
    if (!deductResult.success) {
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 402 },
      );
    }
    await awardCoins(
      recipient.session_id,
      amount as number,
      "Received from a friend",
      sessionId,
    );

    return NextResponse.json({
      success: true,
      sent: amount,
      recipient: recipient.display_name,
      new_balance: deductResult.newBalance,
    });
  } catch (err) {
    console.error("[coins] send_to_human error:", err);
    return NextResponse.json(
      {
        error: "Failed to send coins",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
