import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { session_id, post_id, friend_ids } = await request.json();
    if (!session_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!post_id || !Array.isArray(friend_ids) || friend_ids.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const sql = getDb();
    const user = await sql`
      SELECT id FROM users WHERE session_id = ${session_id}
    ` as unknown as { id: string }[];

    if (!user.length) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    for (const friend_id of friend_ids) {
      const id = randomUUID();
      await sql`
        INSERT INTO friend_post_shares (id, user_id, friend_id, post_id, created_at)
        VALUES (${id}, ${user[0].id}, ${friend_id}, ${post_id}, NOW())
        ON CONFLICT DO NOTHING
      `;
    }

    return NextResponse.json({ success: true, shared_with: friend_ids.length });
  } catch (err) {
    console.error("[friend-shares POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
