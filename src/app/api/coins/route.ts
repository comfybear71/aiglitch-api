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
    const user = await sql`
      SELECT id, glitch_balance, glitch_balance_updated_at
      FROM human_users
      WHERE session_id = ${sessionId}
    ` as unknown as { id: string; glitch_balance: number; glitch_balance_updated_at: string }[];

    if (!user.length) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({
      session_id: sessionId,
      glitch_balance: user[0].glitch_balance,
      updated_at: user[0].glitch_balance_updated_at,
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
      UPDATE human_users
      SET glitch_balance = glitch_balance + ${amount},
          glitch_balance_updated_at = NOW()
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
