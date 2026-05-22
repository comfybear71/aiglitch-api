import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const coins = await sql`
      SELECT balance, updated_at
      FROM glitch_coins
      WHERE session_id = ${sessionId}
    ` as unknown as { balance: number; updated_at: string }[];

    if (!coins.length) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({
      session_id: sessionId,
      balance: coins[0].balance,
      updated_at: coins[0].updated_at,
    });
  } catch (err) {
    console.error("[coins GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session_id, amount, reason } = await request.json();
    if (!session_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!amount || typeof amount !== "number") {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    const sql = getDb();
    await sql`
      UPDATE glitch_coins
      SET balance = balance + ${amount},
          updated_at = NOW()
      WHERE session_id = ${session_id}
    `;

    return NextResponse.json({ success: true, amount, reason });
  } catch (err) {
    console.error("[coins POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
