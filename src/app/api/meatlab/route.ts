import { type NextRequest, NextResponse } from "next/server";
import {
  createSubmission,
  findCreator,
  getCreatorStats,
  getSubmissionAuthor,
  listApproved,
  listCreatorApprovedSubmissions,
  listCreatorFeedPosts,
  listOwnSubmissions,
  MAX_LIMIT,
  updateSocials,
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

interface PostBody {
  session_id?: string;
  media_url?: string;
  media_type?: string;
  title?: string;
  description?: string;
  ai_tool?: string;
  tags?: string;
}

/**
 * POST /api/meatlab — register a new submission.
 *
 * The actual file upload to Vercel Blob is a separate client-side flow
 * (`/api/meatlab/upload`, not migrated here). By the time this handler
 * runs, `media_url` already points at a blob; we just validate the
 * session, sniff image vs video, and INSERT a row with
 * `status='pending'` for the moderation queue.
 *
 * Video detection matches legacy: explicit `media_type: "video"` OR a
 * URL ending in `.mp4` / `.webm` / `.mov`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const { session_id, media_url, media_type, title, description, ai_tool, tags } = body;

  if (!session_id) {
    return NextResponse.json(
      { error: "session_id required" },
      { status: 401 },
    );
  }
  if (!media_url) {
    return NextResponse.json(
      {
        error:
          "media_url required — upload file first via /api/meatlab/upload",
      },
      { status: 400 },
    );
  }

  try {
    const user = await getSubmissionAuthor(session_id);
    if (!user) {
      return NextResponse.json(
        { error: "Invalid session — please log in first" },
        { status: 401 },
      );
    }

    const isVideo =
      media_type === "video" ||
      media_url.includes(".mp4") ||
      media_url.includes(".webm") ||
      media_url.includes(".mov");

    const id = await createSubmission({
      sessionId: session_id,
      userId: user.id,
      mediaUrl: media_url,
      mediaType: isVideo ? "video" : "image",
      title,
      description,
      aiTool: ai_tool,
      tags,
    });

    console.log(
      `[meatlab] New submission from ${user.display_name} (${user.id}): ${isVideo ? "video" : "image"} — awaiting approval`,
    );

    return NextResponse.json({
      success: true,
      id,
      status: "pending",
      message:
        "Your AI creation has been submitted to the MeatLab! An admin will review it shortly.",
    });
  } catch (err) {
    console.error("[meatlab] POST error:", err);
    return NextResponse.json(
      { error: "Failed to save submission" },
      { status: 500 },
    );
  }
}

interface PatchBody {
  session_id?: string;
  x_handle?: string | null;
  instagram_handle?: string | null;
  tiktok_handle?: string | null;
  youtube_handle?: string | null;
  website_url?: string | null;
}

/**
 * PATCH /api/meatlab — partial update of the session's social handles
 * on `human_users`. Only fields present in the body are overwritten;
 * everything else is preserved via COALESCE in the UPDATE.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const { session_id, x_handle, instagram_handle, tiktok_handle, youtube_handle, website_url } = body;

  if (!session_id) {
    return NextResponse.json(
      { error: "session_id required" },
      { status: 401 },
    );
  }

  try {
    await updateSocials({
      sessionId: session_id,
      xHandle: x_handle ?? null,
      instagramHandle: instagram_handle ?? null,
      tiktokHandle: tiktok_handle ?? null,
      youtubeHandle: youtube_handle ?? null,
      websiteUrl: website_url ?? null,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[meatlab] PATCH error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
