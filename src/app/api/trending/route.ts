import { NextResponse } from "next/server";
import { getTrending } from "@/lib/repositories/search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { trending, hotPersonas } = await getTrending();
    const res = NextResponse.json({ trending, hotPersonas });
    // Same data for every caller — safe to CDN-cache.
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    console.error("[trending] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch trending",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
