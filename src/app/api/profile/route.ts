import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getByUsername,
  getMedia,
  getStats,
  isFollowing,
} from "@/lib/repositories/personas";
import {
  getAiComments,
  getBookmarkedSet,
  getByPersona,
  getHumanComments,
  getLikedSet,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MEATLAB_MAX_TOP_LEVEL_COMMENTS = 10;
const MEATBAG_UPLOADS_LIMIT = 100;

/**
 * Cache-Control split:
 *   - No session_id → response is identical for every caller, safe to
 *     CDN-cache. 30s fresh, 5min SWR.
 *   - With session_id → response carries per-session state
 *     (`isFollowing`, `liked`, `bookmarked`). Even though Vercel keys
 *     cache by full URL (so two sessions don't cross-leak), a single
 *     session that follows/likes still gets a stale pre-click response
 *     for up to 30s if we cache. That was bug B3 — fix is
 *     `private, no-store` when session_id is present, same pattern as
 *     /api/likes, /api/bookmarks, /api/notifications.
 */
const PUBLIC_CACHE = "public, s-maxage=30, stale-while-revalidate=300";
const PRIVATE_CACHE = "private, no-store";

interface MeatbagRow {
  id: string;
  display_name: string;
  username: string | null;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  x_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  youtube_handle: string | null;
  website_url: string | null;
  created_at: string;
}

interface MeatbagStats {
  total_uploads: number;
  total_likes: number;
  total_comments: number;
  total_views: number;
}

interface MeatbagUploadRow {
  id: string;
  feed_post_id: string | null;
  [key: string]: unknown;
}

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "Missing username" }, { status: 400 });
  }

  const sessionId = request.nextUrl.searchParams.get("session_id");
  const cacheControl = sessionId ? PRIVATE_CACHE : PUBLIC_CACHE;

  try {
    // ── Persona branch ──────────────────────────────────────────────
    const persona = await getByUsername(username);
    if (persona) {
      const [isFollowingFlag, personaPosts, stats, personaMedia] = await Promise.all([
        sessionId
          ? isFollowing(persona.id, sessionId)
          : Promise.resolve(false),
        getByPersona(persona.id),
        getStats(persona.id),
        getMedia(persona.id),
      ]);

      const postIds = personaPosts.map((p) => p.id);
      const [aiComments, humanComments, likedSet, bookmarkedSet] =
        postIds.length > 0
          ? await Promise.all([
              getAiComments(postIds),
              getHumanComments(postIds),
              sessionId
                ? getLikedSet(postIds, sessionId)
                : Promise.resolve(new Set<string>()),
              sessionId
                ? getBookmarkedSet(postIds, sessionId)
                : Promise.resolve(new Set<string>()),
            ])
          : [[], [], new Set<string>(), new Set<string>()];

      const commentsByPost = threadComments(
        aiComments,
        humanComments,
        MEATLAB_MAX_TOP_LEVEL_COMMENTS,
      );

      const postsWithComments = personaPosts.map((post) => ({
        ...post,
        comments: commentsByPost.get(post.id) ?? [],
        liked: likedSet.has(post.id),
        bookmarked: bookmarkedSet.has(post.id),
      }));

      const res = NextResponse.json({
        persona,
        posts: postsWithComments,
        stats,
        isFollowing: isFollowingFlag,
        personaMedia,
      });
      res.headers.set("Cache-Control", cacheControl);
      return res;
    }

    // ── Meatbag branch (fallback lookup in human_users) ─────────────
    const sql = getDb();
    const slug = username.trim().toLowerCase();
    const meatbagRows = (await sql`
      SELECT id, display_name, username, avatar_emoji, avatar_url, bio,
             x_handle, instagram_handle, tiktok_handle, youtube_handle,
             website_url, created_at
      FROM human_users
      WHERE LOWER(username) = ${slug} OR LOWER(id) = ${slug}
      LIMIT 1
    `) as unknown as MeatbagRow[];

    const meatbag = meatbagRows[0];
    if (!meatbag) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }

    const [uploadsRaw, aggStatsRows] = await Promise.all([
      sql`
        SELECT * FROM meatlab_submissions
        WHERE user_id = ${meatbag.id} AND status = 'approved'
        ORDER BY approved_at DESC
        LIMIT ${MEATBAG_UPLOADS_LIMIT}
      `,
      sql`
        SELECT
          COUNT(*)::int AS total_uploads,
          COALESCE(SUM(like_count + ai_like_count), 0)::int AS total_likes,
          COALESCE(SUM(comment_count), 0)::int AS total_comments,
          COALESCE(SUM(view_count), 0)::int AS total_views
        FROM meatlab_submissions
        WHERE user_id = ${meatbag.id} AND status = 'approved'
      ` as unknown as Promise<MeatbagStats[]>,
    ]);
    const aggStats = (aggStatsRows as unknown as MeatbagStats[])[0] ?? {
      total_uploads: 0,
      total_likes: 0,
      total_comments: 0,
      total_views: 0,
    };

    // B2: attach comments + liked/bookmarked state to each upload via its
    // `feed_post_id` bridge to the `posts` table. Uploads with no
    // feed_post_id (not yet pushed to feed) just get empty arrays/false.
    const uploads = uploadsRaw as unknown as MeatbagUploadRow[];
    const feedPostIds = uploads
      .map((u) => u.feed_post_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    let uploadsWithEnrichment: Array<
      MeatbagUploadRow & {
        comments: unknown[];
        liked: boolean;
        bookmarked: boolean;
      }
    > = uploads.map((u) => ({
      ...u,
      comments: [],
      liked: false,
      bookmarked: false,
    }));

    if (feedPostIds.length > 0) {
      const [aiComments, humanComments, likedSet, bookmarkedSet] =
        await Promise.all([
          getAiComments(feedPostIds),
          getHumanComments(feedPostIds),
          sessionId
            ? getLikedSet(feedPostIds, sessionId)
            : Promise.resolve(new Set<string>()),
          sessionId
            ? getBookmarkedSet(feedPostIds, sessionId)
            : Promise.resolve(new Set<string>()),
        ]);

      const commentsByPost = threadComments(
        aiComments,
        humanComments,
        MEATLAB_MAX_TOP_LEVEL_COMMENTS,
      );

      uploadsWithEnrichment = uploads.map((u) => {
        const feedPostId = u.feed_post_id;
        if (!feedPostId) {
          return { ...u, comments: [], liked: false, bookmarked: false };
        }
        return {
          ...u,
          comments: commentsByPost.get(feedPostId) ?? [],
          liked: likedSet.has(feedPostId),
          bookmarked: bookmarkedSet.has(feedPostId),
        };
      });
    }

    const res = NextResponse.json({
      is_meatbag: true,
      meatbag,
      uploads: uploadsWithEnrichment,
      stats: aggStats,
    });
    res.headers.set("Cache-Control", cacheControl);
    return res;
  } catch (err) {
    console.error("[profile] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load profile",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
