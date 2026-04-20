import { type NextRequest, NextResponse } from "next/server";
import {
  countUnread,
  createShare,
  findFriendSession,
  isFriendWith,
  listInbox,
  markAllRead,
} from "@/lib/repositories/friend-shares";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/friend-shares?session_id=X — this session's inbox of shares.
 *
 * Response: `{ shares, unread }`. Missing session_id returns just
 * `{ shares: [] }` (legacy parity — no `unread` field, no 400).
 * Session-personalised → `Cache-Control: private, no-store`.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return privateNoStore({ shares: [] });
  }

  try {
    const [shares, unread] = await Promise.all([
      listInbox(sessionId),
      countUnread(sessionId),
    ]);
    return privateNoStore({ shares, unread });
  } catch (err) {
    console.error("[friend-shares] GET error:", err);
    return NextResponse.json(
      {
        error: "Failed to load shares",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

interface PostBody {
  session_id?: string;
  action?: string;
  post_id?: string;
  friend_username?: string;
  message?: string;
}

/**
 * POST /api/friend-shares — two actions.
 *
 * `share` with `{ post_id, friend_username, message? }`:
 *   - 400 on missing fields, 404 friend-not-found, 403 not-friends.
 *   - INSERTs a friend_shares row (is_read defaults FALSE in schema).
 *
 * `mark_read`: bulk-UPDATE every unread share for this receiver.
 *
 * Both return `{ success: true }` on success.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const { session_id, action, post_id, friend_username, message } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  try {
    if (action === "share") {
      if (!post_id || !friend_username) {
        return NextResponse.json(
          { error: "Missing post_id or friend_username" },
          { status: 400 },
        );
      }

      const friendSessionId = await findFriendSession(friend_username);
      if (!friendSessionId) {
        return NextResponse.json(
          { error: "Friend not found" },
          { status: 404 },
        );
      }

      const friends = await isFriendWith(session_id, friendSessionId);
      if (!friends) {
        return NextResponse.json(
          { error: "Not friends with this user" },
          { status: 403 },
        );
      }

      await createShare(session_id, friendSessionId, post_id, message);
      return NextResponse.json({ success: true });
    }

    if (action === "mark_read") {
      await markAllRead(session_id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("[friend-shares] POST error:", err);
    return NextResponse.json(
      {
        error: "Failed to process share action",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

function privateNoStore(body: unknown): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
