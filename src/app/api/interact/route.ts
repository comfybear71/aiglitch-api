import { type NextRequest, NextResponse } from "next/server";
import {
  addComment,
  recordShare,
  recordView,
  toggleBookmark,
  toggleCommentLike,
  toggleFollow,
  toggleLike,
  toggleReaction,
} from "@/lib/repositories/interactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUPPORTED_ACTIONS = [
  "like",
  "bookmark",
  "share",
  "view",
  "follow",
  "react",
  "comment",
  "comment_like",
] as const;
const UNSUPPORTED_ACTIONS = ["subscribe"] as const;

interface InteractBody {
  session_id?: string;
  post_id?: string;
  persona_id?: string;
  emoji?: string;
  action?: string;
  content?: string;
  display_name?: string;
  parent_comment_id?: string | null;
  parent_comment_type?: string | null;
  comment_id?: string;
  comment_type?: string;
}

export async function POST(request: NextRequest) {
  let body: InteractBody;
  try {
    body = (await request.json()) as InteractBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { session_id, post_id, persona_id, emoji, action } = body;

  if (!session_id || !action) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

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

  try {
    if (action === "follow") {
      if (!persona_id) {
        return NextResponse.json({ error: "Missing persona_id" }, { status: 400 });
      }
      const result = await toggleFollow(persona_id, session_id);
      return NextResponse.json({ success: true, action: result });
    }

    if (action === "react") {
      if (!post_id) {
        return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
      }
      if (!emoji) {
        return NextResponse.json({ error: "Missing emoji" }, { status: 400 });
      }
      try {
        const result = await toggleReaction(post_id, session_id, emoji);
        return NextResponse.json({ success: true, ...result });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Invalid emoji:")) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
    }

    if (action === "comment") {
      if (!post_id) {
        return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
      }
      const content = body.content;
      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return NextResponse.json(
          { error: "Comment cannot be empty" },
          { status: 400 },
        );
      }
      const comment = await addComment(
        post_id,
        session_id,
        content,
        body.display_name || "Meat Bag",
        body.parent_comment_id,
        body.parent_comment_type,
      );
      // TODO(Slice 4): fire-and-forget AI auto-reply trigger here.
      return NextResponse.json({ success: true, action: "commented", comment });
    }

    if (action === "comment_like") {
      if (!body.comment_id || !body.comment_type) {
        return NextResponse.json(
          { error: "Missing comment_id or comment_type" },
          { status: 400 },
        );
      }
      const result = await toggleCommentLike(
        body.comment_id,
        body.comment_type,
        session_id,
      );
      return NextResponse.json({ success: true, action: result });
    }

    // Remaining supported actions all need post_id.
    if (!post_id) {
      return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    }

    if (action === "like") {
      const result = await toggleLike(post_id, session_id);
      return NextResponse.json({ success: true, action: result });
    }
    if (action === "bookmark") {
      const result = await toggleBookmark(post_id, session_id);
      return NextResponse.json({ success: true, action: result });
    }
    if (action === "share") {
      await recordShare(post_id, session_id);
      return NextResponse.json({ success: true, action: "shared" });
    }
    if (action === "view") {
      await recordView(post_id, session_id);
      return NextResponse.json({ success: true, action: "viewed" });
    }

    // Unreachable — validated above.
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
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
