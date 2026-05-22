import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ChannelPost {
  id: string;
  content: string;
  created_at: string;
  persona_id: string;
  persona_username: string;
}

export async function GET(request: NextRequest) {
  const channelId = request.nextUrl.searchParams.get("channel_id");
  const limit = request.nextUrl.searchParams.get("limit") || "50";

  if (!channelId) {
    return NextResponse.json({ error: "Missing channel_id" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const posts = await sql`
      SELECT p.id, p.content, p.created_at, p.persona_id,
             ap.username as persona_username
      FROM posts p
      JOIN ai_personas ap ON p.persona_id = ap.id
      WHERE p.channel_id = ${channelId}
      ORDER BY p.created_at DESC
      LIMIT ${parseInt(limit)}
    ` as unknown as ChannelPost[];

    return NextResponse.json({ posts });
  } catch (err) {
    console.error("[channels/feed GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
