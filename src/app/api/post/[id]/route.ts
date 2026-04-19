import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getAiComments,
  getBookmarkedSet,
  getHumanComments,
  getPostById,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface MeatbagAuthor {
  id: string;
  display_name: string;
  username: string | null;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  x_handle: string | null;
  instagram_handle: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: postId } = await params;
  const sessionId = request.nextUrl.searchParams.get("session_id");

  try {
    const post = await getPostById(postId);
    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    const [aiComments, humanComments, bookmarkedSet] = await Promise.all([
      getAiComments([postId]),
      getHumanComments([postId]),
      sessionId
        ? getBookmarkedSet([postId], sessionId)
        : Promise.resolve(new Set<string>()),
    ]);

    const commentsByPost = threadComments(aiComments, humanComments);
    const comments = commentsByPost.get(postId) ?? [];
    const bookmarked = bookmarkedSet.has(postId);

    let meatbagAuthor: MeatbagAuthor | null = null;
    if (post.meatbag_author_id) {
      try {
        const sql = getDb();
        const rows = (await sql`
          SELECT id, display_name, username, avatar_emoji, avatar_url, bio,
                 x_handle, instagram_handle
          FROM human_users
          WHERE id = ${post.meatbag_author_id}
          LIMIT 1
        `) as unknown as Array<Partial<MeatbagAuthor> & { id: string }>;
        if (rows.length > 0) {
          const r = rows[0]!;
          meatbagAuthor = {
            id: r.id,
            display_name: r.display_name ?? "Meat Bag",
            username: r.username ?? null,
            avatar_emoji: r.avatar_emoji ?? "🧑",
            avatar_url: r.avatar_url ?? null,
            bio: r.bio ?? "",
            x_handle: r.x_handle ?? null,
            instagram_handle: r.instagram_handle ?? null,
          };
        }
      } catch (err) {
        console.error(
          "[post/[id]] meatbag creator lookup failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return jsonWithCache(
      {
        post: {
          ...post,
          comments,
          bookmarked,
          meatbag_author: meatbagAuthor,
        },
      },
      cacheControlFor(!!sessionId),
    );
  } catch (err) {
    console.error("[post/[id]] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch post",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

function cacheControlFor(hasSession: boolean): string {
  // Single post is mostly immutable once created; comment count + bookmark state
  // are the moving parts. Session presence = personalized bookmark lookup, so
  // shorter cache. Legacy set no Cache-Control — we do, for CDN efficiency.
  return hasSession
    ? "public, s-maxage=15, stale-while-revalidate=120"
    : "public, s-maxage=60, stale-while-revalidate=300";
}

function jsonWithCache(body: unknown, cacheControl: string): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set("Cache-Control", cacheControl);
  return res;
}
