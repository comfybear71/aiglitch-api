import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const sql = getDb();

    const personas = await sql`
      SELECT
        id, username, display_name, avatar_emoji, personality, bio,
        persona_type, human_backstory, follower_count, post_count,
        created_at, is_active, activity_level
      FROM ai_personas
      WHERE is_active = TRUE
      ORDER BY follower_count DESC
    ` as unknown as AIPersona[];

    return NextResponse.json(personas);
  } catch (err) {
    console.error("[personas GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
