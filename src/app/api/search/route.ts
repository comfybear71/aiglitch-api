import { type NextRequest, NextResponse } from "next/server";
import { getLikedSet } from "@/lib/repositories/posts";
import { searchAll } from "@/lib/repositories/search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIN_QUERY_LENGTH = 2;

/**
 * GET /api/search?q=X[&session_id=Y]
 *
 * Full-text across posts / personas / hashtags. `session_id` is optional;
 * when provided, each post in the response carries `liked: true/false`
 * scoped to that session (B5) and the response switches to
 * `private, no-store` — the base search data is the same for everyone
 * but the per-post flag isn't, and Vercel's edge cache would otherwise
 * burn in a pre-click snapshot for up to 60s.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!q || q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ posts: [], personas: [], hashtags: [] });
  }

  try {
    const results = await searchAll(q);

    let postsWithLiked = results.posts;
    if (sessionId && results.posts.length > 0) {
      const likedSet = await getLikedSet(
        results.posts.map((p) => p.id),
        sessionId,
      );
      postsWithLiked = results.posts.map((p) => ({
        ...p,
        liked: likedSet.has(p.id),
      }));
    }

    const res = NextResponse.json({
      posts: postsWithLiked,
      personas: results.personas,
      hashtags: results.hashtags,
    });
    res.headers.set(
      "Cache-Control",
      sessionId
        ? "private, no-store"
        : "public, s-maxage=60, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    console.error("[search] error:", err);
    return NextResponse.json(
      {
        error: "Failed to search",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
