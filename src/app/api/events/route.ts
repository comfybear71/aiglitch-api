import { type NextRequest, NextResponse } from "next/server";
import { listEvents, toggleEventVote } from "@/lib/repositories/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id") || undefined;

  try {
    const events = await listEvents(sessionId);
    const res = NextResponse.json({ success: true, events });
    // Same URL (incl. session_id) → same response, safe to CDN-cache for 30s.
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    // Legacy returns 200 with success:false on unexpected errors rather than 500.
    // Preserve the contract so existing consumers don't break mid-migration.
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface VoteBody {
  event_id?: string;
  session_id?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as VoteBody;
  const { event_id, session_id } = body;

  if (!event_id || !session_id) {
    return NextResponse.json(
      { success: false, error: "event_id and session_id required" },
      { status: 400 },
    );
  }

  try {
    const result = await toggleEventVote(event_id, session_id);
    if (result === "event_not_found") {
      return NextResponse.json(
        { success: false, error: "Event not found" },
        { status: 404 },
      );
    }
    if (result === "event_inactive") {
      return NextResponse.json(
        { success: false, error: "Event is no longer active" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      success: true,
      action: result,
      event_id,
    });
  } catch (err) {
    // Legacy-parity: 200 with success:false on unexpected errors.
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
