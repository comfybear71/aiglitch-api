import { type NextRequest, NextResponse } from "next/server";
import { searchAll } from "@/lib/repositories/search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIN_QUERY_LENGTH = 2;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ posts: [], personas: [], hashtags: [] });
  }

  try {
    const results = await searchAll(q);
    const res = NextResponse.json(results);
    // Same query returns same results for every caller — safe to CDN-cache.
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    console.error("[search] error:", err);
    return NextResponse.json(
      {
        error: "Failed to search",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
