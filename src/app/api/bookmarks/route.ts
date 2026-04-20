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
    const postsWithComments = await attachFlatComments(
      bookmarkedPosts,
      { bookmarked: true },
      { sessionId }, // B4: attach per-post `liked` so a bookmarked+liked post still renders with a filled heart
    );
    const res = NextResponse.json({ posts: postsWithComments });
    // Session-personalised response — never share at the CDN.
    // Previously tried public/s-maxage=15/SWR=120; Vercel's edge held stale
    // empties across fresh writes, so users saw empty lists even after bookmarking.
    res.headers.set("Cache-Control", "private, no-store");
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
