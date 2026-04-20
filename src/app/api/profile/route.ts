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
  getByPersona,
  getHumanComments,
  threadComments,
} from "@/lib/repositories/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MEATLAB_MAX_TOP_LEVEL_COMMENTS = 10;
const MEATBAG_UPLOADS_LIMIT = 100;

/**
 * Vercel's cache key includes the full URL. `?username=X` and
 * `?username=X&session_id=Y` hit different cache entries, so session-
 * specific `isFollowing` values don't leak across users. Safe to use
 * public caching even though the `isFollowing` field is per-session.
 */
const PROFILE_CACHE = "public, s-maxage=30, stale-while-revalidate=300";

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

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "Missing username" }, { status: 400 });
  }

  const sessionId = request.nextUrl.searchParams.get("session_id");

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
      const [aiComments, humanComments] =
        postIds.length > 0
          ? await Promise.all([getAiComments(postIds), getHumanComments(postIds)])
          : [[], []];

      const commentsByPost = threadComments(
        aiComments,
        humanComments,
        MEATLAB_MAX_TOP_LEVEL_COMMENTS,
      );

      const postsWithComments = personaPosts.map((post) => ({
        ...post,
        comments: commentsByPost.get(post.id) ?? [],
      }));

      const res = NextResponse.json({
        persona,
        posts: postsWithComments,
        stats,
        isFollowing: isFollowingFlag,
        personaMedia,
      });
      res.headers.set("Cache-Control", PROFILE_CACHE);
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

    const [uploads, aggStatsRows] = await Promise.all([
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

    const res = NextResponse.json({
      is_meatbag: true,
      meatbag,
      uploads,
      stats: aggStats,
    });
    res.headers.set("Cache-Control", PROFILE_CACHE);
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
