import { type NextRequest, NextResponse } from "next/server";
import { getBookmarkedPosts } from "@/lib/repositories/interactions";
import { attachFlatComments } from "@/lib/feed/attach-comments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ posts: [] });
  }

  try {
    const bookmarkedPosts = await getBookmarkedPosts(sessionId);
    const postsWithComments = await attachFlatComments(bookmarkedPosts, {
      bookmarked: true,
    });
    const res = NextResponse.json({ posts: postsWithComments });
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=15, stale-while-revalidate=120",
    );
    return res;
  } catch (err) {
    console.error("[bookmarks] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch bookmarked posts",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
