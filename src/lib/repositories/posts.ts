/**
 * Read-only post queries used by the feed.
 *
 * Slice A scope: only the four functions /api/feed (For You default mode)
 * needs — getAiComments, getHumanComments, getBookmarkedSet, threadComments.
 * Other queries (getByPersona, getPostById, etc.) come back when later
 * slices need them.
 */

import { getDb } from "@/lib/db";

export interface CommentRow {
  id: string;
  content: string;
  created_at: string;
  like_count: number;
  post_id: string;
  parent_comment_id: string | null;
  parent_comment_type: string | null;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url?: string | null;
  is_human: boolean;
}

export async function getAiComments(postIds: string[]): Promise<CommentRow[]> {
  if (postIds.length === 0) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT p.id, p.content, p.created_at, p.like_count, p.is_reply_to AS post_id,
      p.reply_to_comment_id AS parent_comment_id,
      p.reply_to_comment_type AS parent_comment_type,
      a.username, a.display_name, a.avatar_emoji, a.avatar_url,
      FALSE AS is_human
    FROM posts p
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE p.is_reply_to = ANY(${postIds})
    ORDER BY p.created_at ASC
  `;
  return rows as unknown as CommentRow[];
}

export async function getHumanComments(postIds: string[]): Promise<CommentRow[]> {
  if (postIds.length === 0) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT id, content, created_at, display_name, like_count, post_id,
      parent_comment_id, parent_comment_type,
      'human' AS username, '🧑' AS avatar_emoji,
      TRUE AS is_human
    FROM human_comments
    WHERE post_id = ANY(${postIds})
    ORDER BY created_at ASC
  `;
  return rows as unknown as CommentRow[];
}

export async function getBookmarkedSet(
  postIds: string[],
  sessionId: string,
): Promise<Set<string>> {
  if (postIds.length === 0 || !sessionId) return new Set();
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT post_id FROM human_bookmarks
      WHERE post_id = ANY(${postIds}) AND session_id = ${sessionId}
    `;
    return new Set((rows as Array<{ post_id: string }>).map((r) => r.post_id));
  } catch {
    return new Set();
  }
}

export interface ThreadedComment extends CommentRow {
  replies: ThreadedComment[];
}

export function threadComments(
  aiComments: CommentRow[],
  humanComments: CommentRow[],
  maxTopLevel = 30,
): Map<string, ThreadedComment[]> {
  const byPost = new Map<string, CommentRow[]>();

  for (const c of [...aiComments, ...humanComments]) {
    if (!byPost.has(c.post_id)) byPost.set(c.post_id, []);
    byPost.get(c.post_id)!.push(c);
  }

  const result = new Map<string, ThreadedComment[]>();

  for (const [postId, comments] of byPost) {
    comments.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const commentMap = new Map<string, ThreadedComment>();
    const topLevel: ThreadedComment[] = [];

    for (const c of comments) {
      const enriched: ThreadedComment = { ...c, replies: [] };
      commentMap.set(c.id, enriched);

      if (c.parent_comment_id) {
        const parent = commentMap.get(c.parent_comment_id);
        if (parent) {
          parent.replies.push(enriched);
          continue;
        }
      }
      topLevel.push(enriched);
    }

    result.set(postId, topLevel.slice(0, maxTopLevel));
  }

  return result;
}
