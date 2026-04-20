import { type NextRequest, NextResponse } from "next/server";
import {
  findCreator,
  getCreatorStats,
  listApproved,
  listCreatorApprovedSubmissions,
  listCreatorFeedPosts,
  listOwnSubmissions,
  MAX_LIMIT,
} from "@/lib/repositories/meatlab";
import {
  getAiComments,
  getBookmarkedSet,
  getHumanComments,
  getLikedSet,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;

/**
 * GET /api/meatlab
 *
 * Three modes:
 *   - `?approved=1`               → public gallery of approved posts
 *   - `?creator=<username-or-id>` → one creator's profile + posts + stats + feedPosts
 *   - default (with session_id)   → the caller's own submissions (all statuses)
 *
 * All three accept `?limit=N` (capped at 100, default 20).
 *
 * **B6 fix (consumer QA matrix):** the `creator` mode's `feedPosts`
 * array now carries threaded comments + per-session `liked` +
 * `bookmarked`, so MeatLab's creator page can render the real comment
 * thread instead of just the `comment_count` counter. Matches the B1
 * + B2 fix on `/api/profile` — same bug pattern, different endpoint.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const sessionId = params.get("session_id");
  const approved = params.get("approved") === "1";
  const creatorSlug = params.get("creator");
  const limit = clampLimit(params.get("limit"));
  const cacheControl = sessionId ? "private, no-store" : "public, s-maxage=30, stale-while-revalidate=300";

  try {
    if (creatorSlug) {
      return await handleCreator(creatorSlug, sessionId, limit, cacheControl);
    }

    if (approved) {
      const posts = await listApproved(limit);
      const res = NextResponse.json({ total: posts.length, posts });
      res.headers.set("Cache-Control", cacheControl);
      return res;
    }

    if (!sessionId) {
      return NextResponse.json(
        { error: "session_id required" },
        { status: 401 },
      );
    }

    const posts = await listOwnSubmissions(sessionId, limit);
    const res = NextResponse.json({ total: posts.length, posts });
    res.headers.set("Cache-Control", cacheControl);
    return res;
  } catch (err) {
    console.error("[meatlab] GET error:", err);
    return NextResponse.json(
      {
        error: "Failed to load meatlab",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

async function handleCreator(
  slug: string,
  sessionId: string | null,
  limit: number,
  cacheControl: string,
): Promise<NextResponse> {
  const creator = await findCreator(slug);
  if (!creator) {
    return NextResponse.json({ error: "Creator not found" }, { status: 404 });
  }

  const [stats, posts, feedPosts] = await Promise.all([
    getCreatorStats(creator.id),
    listCreatorApprovedSubmissions(creator.id, limit),
    listCreatorFeedPosts(creator.id),
  ]);

  // B6: attach threaded comments + per-session liked + bookmarked to the
  // feedPosts array. feedPosts is what consumer PostCards render against;
  // it carries real engagement. Without this, each card shows comment_count
  // from the column but an empty comment list — exactly the MeatLab bug.
  let feedPostsEnriched: Array<
    (typeof feedPosts)[number] & {
      comments: unknown[];
      liked: boolean;
      bookmarked: boolean;
    }
  > = feedPosts.map((p) => ({
    ...p,
    comments: [],
    liked: false,
    bookmarked: false,
  }));

  if (feedPosts.length > 0) {
    const ids = feedPosts.map((p) => p.id);
    const [aiComments, humanComments, likedSet, bookmarkedSet] = await Promise.all([
      getAiComments(ids),
      getHumanComments(ids),
      sessionId ? getLikedSet(ids, sessionId) : Promise.resolve(new Set<string>()),
      sessionId ? getBookmarkedSet(ids, sessionId) : Promise.resolve(new Set<string>()),
    ]);
    const commentsByPost = threadComments(aiComments, humanComments);
    feedPostsEnriched = feedPosts.map((p) => ({
      ...p,
      comments: commentsByPost.get(p.id) ?? [],
      liked: likedSet.has(p.id),
      bookmarked: bookmarkedSet.has(p.id),
    }));
  }

  const res = NextResponse.json({
    creator,
    stats,
    total: posts.length,
    posts,
    feedPosts: feedPostsEnriched,
  });
  res.headers.set("Cache-Control", cacheControl);
  return res;
}

function clampLimit(raw: string | null): number {
  const parsed = parseInt(raw ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * POST + PATCH: new submission + social-handle updates.
 *
 * Deferred to a follow-up PR — POST needs Vercel Blob mechanics
 * (media_url validation, media_type sniffing, INSERT into
 * meatlab_submissions, user verification). PATCH is trivial but lands
 * with POST so both write paths migrate together.
 *
 * Returns 501 here so consumers fall through to legacy via the
 * strangler. Same pattern as the earlier /api/interact and /api/coins
 * deferred slices.
 */
export async function POST(): Promise<NextResponse> {
  return methodNotYetMigrated("POST");
}

export async function PATCH(): Promise<NextResponse> {
  return methodNotYetMigrated("PATCH");
}

function methodNotYetMigrated(method: string): NextResponse {
  return NextResponse.json(
    {
      error: "method_not_yet_migrated",
      method,
      note: "This /api/meatlab write method is not yet migrated; use the legacy backend in the meantime.",
    },
    { status: 501 },
  );
}
