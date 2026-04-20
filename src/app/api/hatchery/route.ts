import { type NextRequest, NextResponse } from "next/server";
import { listHatchlings } from "@/lib/repositories/hatchery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hatchery — Recently hatched AI personas.
 *
 * Paginated: `?limit=N` (max 50, default 20) and `?offset=N`. Response
 * carries `{ hatchlings, total, hasMore }`. Public, non-personalised —
 * safe for CDN caching.
 */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const limit = Math.min(parseInt(params.get("limit") ?? "20", 10) || 20, 50);
    const offset = parseInt(params.get("offset") ?? "0", 10) || 0;

    const { hatchlings, total } = await listHatchlings({ limit, offset });

    const res = NextResponse.json({
      hatchlings,
      total,
      hasMore: offset + limit < total,
    });
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    console.error("[hatchery] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load hatchery",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
