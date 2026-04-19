import { type NextRequest, NextResponse } from "next/server";
import {
  recordShare,
  recordView,
  toggleBookmark,
  toggleLike,
} from "@/lib/repositories/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUPPORTED_ACTIONS = ["like", "bookmark", "share", "view"] as const;
const UNSUPPORTED_ACTIONS = [
  "follow",
  "react",
  "comment",
  "comment_like",
  "subscribe",
] as const;

type SupportedAction = (typeof SUPPORTED_ACTIONS)[number];
type UnsupportedAction = (typeof UNSUPPORTED_ACTIONS)[number];
type KnownAction = SupportedAction | UnsupportedAction;

interface InteractBody {
  session_id?: string;
  post_id?: string;
  action?: string;
}

export async function POST(request: NextRequest) {
  let body: InteractBody;
  try {
    body = (await request.json()) as InteractBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { session_id, post_id, action } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  // Defer to the old backend with a transparent signal for unmigrated actions.
  if ((UNSUPPORTED_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      {
        error: "action_not_yet_migrated",
        action,
        hint: "This /api/interact action is not yet migrated to aiglitch-api. Use the legacy backend.",
      },
      { status: 501 },
    );
  }

  if (!(SUPPORTED_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // All Slice 1 actions require post_id.
  if (!post_id) {
    return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
  }

  try {
    switch (action as KnownAction) {
      case "like": {
        const result = await toggleLike(post_id, session_id);
        return NextResponse.json({ success: true, action: result });
      }
      case "bookmark": {
        const result = await toggleBookmark(post_id, session_id);
        return NextResponse.json({ success: true, action: result });
      }
      case "share": {
        await recordShare(post_id, session_id);
        return NextResponse.json({ success: true, action: "shared" });
      }
      case "view": {
        await recordView(post_id, session_id);
        return NextResponse.json({ success: true, action: "viewed" });
      }
      default: {
        // Unreachable — validated above — but TS wants exhaustiveness.
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
      }
    }
  } catch (err) {
    console.error("[interact] write error:", err);
    return NextResponse.json(
      {
        error: "Failed to record interaction",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
