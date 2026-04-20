/**
 * Helper shared by /api/likes and /api/bookmarks (and any future endpoint
 * that returns a flat post list).
 *
 * Both endpoints render a list of posts with a FLAT comment array (not the
 * threaded tree that /api/feed + /api/post/[id] use). Top 20 comments per
 * post, sorted chronologically ascending. Legacy duplicated this inline
 * in both route handlers — this helper centralises it.
 *
 * The `overlay` is merged into each post to add a static endpoint-specific
 * flag: `{liked: true}` for /api/likes (every item is liked), or
 * `{bookmarked: true}` for /api/bookmarks (every item is bookmarked).
 *
 * The `sessionId` opt triggers a per-post `liked` lookup against
 * `human_likes` — used by /api/bookmarks (B4) so a bookmarked post that's
 * also liked renders with a filled heart, not just a filled bookmark.
 * Overlay wins over the per-post lookup, so /api/likes passing
 * `{liked: true}` still short-circuits correctly without an extra query.
 */

import {
  getAiComments,
  getHumanComments,
  getLikedSet,
  type CommentRow,
} from "@/lib/repositories/posts";

const FLAT_COMMENTS_PER_POST = 20;

export interface PostWithId {
  id: string;
  [key: string]: unknown;
}

export async function attachFlatComments<T extends PostWithId>(
  posts: T[],
  overlay: Record<string, unknown> = {},
  opts: { sessionId?: string } = {},
): Promise<Array<T & { comments: CommentRow[] }>> {
  const postIds = posts.map((p) => p.id);
  const needLikedLookup = !!opts.sessionId && !("liked" in overlay);

  const [aiComments, humanComments, likedSet] =
    postIds.length > 0
      ? await Promise.all([
          getAiComments(postIds),
          getHumanComments(postIds),
          needLikedLookup
            ? getLikedSet(postIds, opts.sessionId!)
            : Promise.resolve(new Set<string>()),
        ])
      : [[], [], new Set<string>()];

  const commentsByPost = new Map<string, CommentRow[]>();
  for (const c of aiComments) {
    const list = commentsByPost.get(c.post_id) ?? [];
    list.push(c);
    commentsByPost.set(c.post_id, list);
  }
  for (const c of humanComments) {
    const list = commentsByPost.get(c.post_id) ?? [];
    list.push(c);
    commentsByPost.set(c.post_id, list);
  }

  return posts.map((post) => {
    const comments = (commentsByPost.get(post.id) ?? [])
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
      .slice(0, FLAT_COMMENTS_PER_POST);
    const likedOverlay = needLikedLookup
      ? { liked: likedSet.has(post.id) }
      : {};
    return { ...post, ...overlay, ...likedOverlay, comments };
  });
}
