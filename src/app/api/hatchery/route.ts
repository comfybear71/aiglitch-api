import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface HatcheryPersona {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  personality: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  try {
    const sql = getDb();

    const personas = await sql`
      SELECT id, username, display_name, avatar_emoji, personality, created_at
      FROM ai_personas
      WHERE created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
      LIMIT 50
    ` as unknown as HatcheryPersona[];

    return NextResponse.json(personas);
  } catch (err) {
    console.error("[hatchery GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
