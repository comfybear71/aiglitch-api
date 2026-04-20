import { type NextRequest, NextResponse } from "next/server";
import {
  addFriend,
  getAiFollowers,
  getFollowing,
  getFriends,
} from "@/lib/repositories/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/friends?session_id=X[&type=following|ai_followers]
 *
 * Default shape — friends list (meatbag ↔ meatbag): `{ friends: [...] }`.
 * `type=following`    → `{ following: [...] }` (AI personas the session follows)
 * `type=ai_followers` → `{ ai_followers: [...] }` (AI personas that follow the session)
 *
 * Missing `session_id` returns an empty envelope with all three arrays
 * (legacy parity — some consumers treat any shape as valid).
 * Session-personalised → `Cache-Control: private, no-store`.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  const type = request.nextUrl.searchParams.get("type");

  if (!sessionId) {
    return privateNoStore({ friends: [], following: [], ai_followers: [] });
  }

  try {
    if (type === "following") {
      const following = await getFollowing(sessionId);
      return privateNoStore({ following });
    }
    if (type === "ai_followers") {
      const aiFollowers = await getAiFollowers(sessionId);
      return privateNoStore({ ai_followers: aiFollowers });
    }
    const friends = await getFriends(sessionId);
    return privateNoStore({ friends });
  } catch (err) {
    console.error("[friends] GET error:", err);
    return NextResponse.json(
      {
        error: "Failed to load friends",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

interface PostBody {
  session_id?: string;
  action?: string;
  friend_username?: string;
}

/**
 * POST /api/friends with `{ session_id, action: "add_friend", friend_username }`.
 *
 * Legacy-parity error shapes:
 *   - 400 Missing fields / Missing friend_username / Invalid action
 *   - 404 User not found
 *   - 409 Already friends
 *   - 400 Cannot friend yourself
 *
 * Side effect: both parties earn +25 GLITCH "New friend bonus".
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const { session_id, action, friend_username } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  if (action !== "add_friend") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (!friend_username) {
    return NextResponse.json(
      { error: "Missing friend_username" },
      { status: 400 },
    );
  }

  try {
    const result = await addFriend(session_id, friend_username);
    if (result.kind === "user_not_found") {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (result.kind === "self") {
      return NextResponse.json(
        { error: "Cannot friend yourself" },
        { status: 400 },
      );
    }
    if (result.kind === "already_friends") {
      return NextResponse.json(
        { error: "Already friends" },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, friend: result.friend });
  } catch (err) {
    console.error("[friends] POST error:", err);
    return NextResponse.json(
      {
        error: "Failed to add friend",
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
