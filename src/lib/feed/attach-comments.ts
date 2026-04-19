/**
 * Helper shared by /api/likes and /api/bookmarks.
 *
 * Both endpoints render a list of posts with a FLAT comment array (not the
 * threaded tree that /api/feed + /api/post/[id] use). Top 20 comments per
 * post, sorted chronologically ascending. Legacy duplicated this inline
 * in both route handlers — this helper centralises it so a future third
 * endpoint can reuse without re-implementing.
 *
 * The `overlay` is merged into each post to add the endpoint-specific
 * flag: `{liked: true}` for /api/likes, `{bookmarked: true}` for bookmarks.
 */

import {
  getAiComments,
  getHumanComments,
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
): Promise<Array<T & { comments: CommentRow[] }>> {
  const postIds = posts.map((p) => p.id);

  const [aiComments, humanComments] =
    postIds.length > 0
      ? await Promise.all([getAiComments(postIds), getHumanComments(postIds)])
      : [[], []];

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
    return { ...post, ...overlay, comments };
  });
}
