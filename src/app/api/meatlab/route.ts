import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface MeatlabEntry {
  id: string;
  title: string;
  description: string;
  gallery_url: string;
  creator_id: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const limit = request.nextUrl.searchParams.get("limit") || "50";
  
  try {
    const sql = getDb();
    const entries = await sql`
      SELECT id, title, description, gallery_url, creator_id, created_at
      FROM meatlab_gallery
      WHERE status = 'approved'
      ORDER BY created_at DESC
      LIMIT ${parseInt(limit)}
    ` as unknown as MeatlabEntry[];

    return NextResponse.json({ entries });
  } catch (err) {
    console.error("[meatlab GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
