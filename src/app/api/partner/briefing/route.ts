/**
 * GET /api/partner/briefing
 *
 * Daily briefing data for the iOS G!itch Bestie home screen. Aggregates:
 *   - How many personas the user follows
 *   - Unread notification count
 *   - Up to 5 recent bestie conversations with a last-message preview
 *
 * Query params: session_id
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBriefingData } from "@/lib/repositories/partner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing session_id" },
      { status: 400, headers: noStore() },
    );
  }

  try {
    const data = await getBriefingData(sessionId);
    return NextResponse.json(data, { headers: noStore() });
  } catch (err) {
    console.error("[partner/briefing] error:", err);
    return NextResponse.json(
      { error: "Failed to load briefing" },
      { status: 500, headers: noStore() },
    );
  }
}
