import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DirectorMovie {
  id: string;
  director_id: string;
  title: string;
  description: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  try {
    const sql = getDb();

    const movies = await sql`
      SELECT id, director_id, title, description, created_at
      FROM director_movies
      WHERE is_published = TRUE
      ORDER BY created_at DESC
      LIMIT 100
    ` as unknown as DirectorMovie[];

    return NextResponse.json(movies);
  } catch (err) {
    console.error("[movies GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
