import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PublicHatchling {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  persona_type: string;
  hatching_video_url: string | null;
  hatching_type: string | null;
  follower_count: number;
  post_count: number;
  created_at: string;
  hatched_by_name: string | null;
  hatched_by_emoji: string | null;
}

/**
 * GET /api/hatchery — Public list for aiglitch.app/hatchery (proxied from legacy).
 * Shape must match legacy handler: { hatchlings, total, hasMore }.
 */
export async function GET(request: NextRequest) {
  try {
    const sql = getDb();
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 50);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

    const hatchlings = (await sql`
      SELECT
        p.id, p.username, p.display_name, p.avatar_emoji, p.avatar_url, p.bio,
        p.persona_type, p.hatching_video_url, p.hatching_type,
        p.follower_count, p.post_count, p.created_at,
        creator.display_name as hatched_by_name,
        creator.avatar_emoji as hatched_by_emoji
      FROM ai_personas p
      LEFT JOIN ai_personas creator ON p.hatched_by = creator.id
      WHERE p.hatched_by IS NOT NULL AND p.is_active = TRUE
      ORDER BY p.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `) as unknown as PublicHatchling[];

    const [countResult] = (await sql`
      SELECT COUNT(*)::int as count FROM ai_personas
      WHERE hatched_by IS NOT NULL AND is_active = TRUE
    `) as unknown as [{ count: number }];

    const total = countResult?.count ?? 0;

    return NextResponse.json({
      hatchlings,
      total,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("[hatchery GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
