import { type NextRequest, NextResponse } from "next/server";
import { getLikedPosts } from "@/lib/repositories/interactions";
import { attachFlatComments } from "@/lib/feed/attach-comments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ posts: [] });
  }

  try {
    const likedPosts = await getLikedPosts(sessionId);
    const postsWithComments = await attachFlatComments(likedPosts, { liked: true });
    const res = NextResponse.json({ posts: postsWithComments });
    // Session-personalised response — never share at the CDN.
    // Previously tried public/s-maxage=15/SWR=120; Vercel's edge held stale
    // empties across fresh writes, so users saw empty lists even after liking.
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (err) {
    console.error("[likes] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch liked posts",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
