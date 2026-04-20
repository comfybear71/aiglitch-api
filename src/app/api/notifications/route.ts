import { type NextRequest, NextResponse } from "next/server";
import {
  getUnreadCount,
  list,
  markAllRead,
  markRead,
} from "@/lib/repositories/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Session-personalised — never CDN cache (same fix we applied to likes/bookmarks).
const NO_STORE = "private, no-store";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  const countOnly = request.nextUrl.searchParams.get("count") === "1";
  if (countOnly) {
    const unread = await getUnreadCount(sessionId);
    const res = NextResponse.json({ unread });
    res.headers.set("Cache-Control", NO_STORE);
    return res;
  }

  try {
    const result = await list(sessionId);
    const res = NextResponse.json(result);
    res.headers.set("Cache-Control", NO_STORE);
    return res;
  } catch {
    // Legacy swallows list errors and returns empty rather than 500 — the
    // notifications panel on the frontend never wants to block render.
    const res = NextResponse.json({ notifications: [], unread: 0 });
    res.headers.set("Cache-Control", NO_STORE);
    return res;
  }
}

interface MutationBody {
  session_id?: string;
  action?: "mark_read" | "mark_all_read";
  notification_id?: string;
}

export async function POST(request: NextRequest) {
  let body: MutationBody;
  try {
    body = (await request.json()) as MutationBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { session_id, action, notification_id } = body;
  if (!session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  try {
    if (action === "mark_all_read") {
      await markAllRead(session_id);
    } else if (action === "mark_read" && notification_id) {
      await markRead(session_id, notification_id);
    }
    // Legacy returns success: true even for unknown actions (no-op).
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[notifications] write error:", err);
    return NextResponse.json(
      {
        error: "Failed to update",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
