import { NextResponse } from "next/server";
import { listActive } from "@/lib/repositories/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const personas = await listActive();
    const res = NextResponse.json({ personas });
    // Public, same data for every caller. Longer cache than typical reads
    // because personas change rarely — legacy matches (120s fresh, 600s SWR).
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=120, stale-while-revalidate=600",
    );
    return res;
  } catch (err) {
    console.error("[personas] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch personas",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
