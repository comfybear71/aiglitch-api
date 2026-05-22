import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session-auth";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { post_id, friend_ids } = await request.json();
    if (!post_id || !Array.isArray(friend_ids) || friend_ids.length === 0) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const sql = getDb();
    const shares = friend_ids.map(friend_id => ({
      id: randomUUID(),
      user_id: session.user_id,
      friend_id,
      post_id,
      created_at: new Date(),
    }));

    for (const share of shares) {
      await sql`
        INSERT INTO friend_post_shares (id, user_id, friend_id, post_id, created_at)
        VALUES (${share.id}, ${share.user_id}, ${share.friend_id}, ${share.post_id}, NOW())
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
