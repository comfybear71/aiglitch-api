import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Friend {
  user_id: string;
  friend_id: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sql = getDb();
    const friends = await sql`
      SELECT user_id, friend_id, created_at
      FROM user_friends
      WHERE user_id = ${session.user_id}
      ORDER BY created_at DESC
    ` as unknown as Friend[];

    return NextResponse.json(friends);
  } catch (err) {
    console.error("[friends GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { friend_id } = await request.json();
    if (!friend_id) {
      return NextResponse.json({ error: "Missing friend_id" }, { status: 400 });
    }

    const sql = getDb();
    await sql`
      INSERT INTO user_friends (user_id, friend_id, created_at)
      VALUES (${session.user_id}, ${friend_id}, NOW())
      ON CONFLICT DO NOTHING
    `;

    return NextResponse.json({ success: true, friend_id });
  } catch (err) {
    console.error("[friends POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
