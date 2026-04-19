/**
 * Human ↔ content interactions.
 *
 * Slices 1 + 2 + 3 + subscribe scope: like, bookmark, share, view, follow,
 * react, comment, comment_like, subscribe (+ internal trackInterest,
 * maybeAIFollowBack).
 *
 * Deferred to later slices:
 *   - Slice 5: coin awards (requires users-repo + COIN_REWARDS port)
 *   - Slice 4: AI auto-reply trigger (requires AI engine port) — held
 *     until last because it's the largest remaining port.
 *
 * toggleLike + addComment have coin-award side-effects. Both are wrapped in
 * try/catch and marked non-critical in legacy. Stripped here with a clearly-
 * marked TODO — Slice 5 retrofits them once users.awardCoins lands.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

/**
 * Legacy value from `AI_BEHAVIOR.followBackProb` in bible/constants.ts.
 * Inlined here because only this slice cares; extract to a shared constants
 * file when a second slice needs AI_BEHAVIOR values.
 */
const AI_FOLLOW_BACK_PROB = 0.40;

const VALID_EMOJIS = ["funny", "sad", "shocked", "crap"] as const;
export type ReactionEmoji = (typeof VALID_EMOJIS)[number];

/**
 * Emoji → content_feedback score delta (applied on add).
 * Matches the exact legacy formula.
 */
const EMOJI_SCORE_DELTA: Record<ReactionEmoji, number> = {
  funny: 3,
  shocked: 2,
  sad: 1,
  crap: -2,
};

/** Toggle a like row + post counter. Returns the new state. */
export async function toggleLike(
  postId: string,
  sessionId: string,
): Promise<"liked" | "unliked"> {
  const sql = getDb();
  const existing = (await sql`
    SELECT id FROM human_likes
    WHERE post_id = ${postId} AND session_id = ${sessionId}
  `) as unknown as Array<{ id: string }>;

  if (existing.length === 0) {
    await sql`
      INSERT INTO human_likes (id, post_id, session_id)
      VALUES (${randomUUID()}, ${postId}, ${sessionId})
    `;
    await sql`UPDATE posts SET like_count = like_count + 1 WHERE id = ${postId}`;
    await trackInterest(sessionId, postId);
    // TODO(Slice 5): award first-like bonus + persona like reward here.
    return "liked";
  }

  await sql`
    DELETE FROM human_likes
    WHERE post_id = ${postId} AND session_id = ${sessionId}
  `;
  await sql`
    UPDATE posts
    SET like_count = GREATEST(0, like_count - 1)
    WHERE id = ${postId}
  `;
  return "unliked";
}

/** Toggle a bookmark row. No post counter (legacy parity). */
export async function toggleBookmark(
  postId: string,
  sessionId: string,
): Promise<"bookmarked" | "unbookmarked"> {
  const sql = getDb();
  const existing = (await sql`
    SELECT id FROM human_bookmarks
    WHERE post_id = ${postId} AND session_id = ${sessionId}
  `) as unknown as Array<{ id: string }>;

  if (existing.length === 0) {
    await sql`
      INSERT INTO human_bookmarks (id, post_id, session_id)
      VALUES (${randomUUID()}, ${postId}, ${sessionId})
    `;
    return "bookmarked";
  }

  await sql`
    DELETE FROM human_bookmarks
    WHERE post_id = ${postId} AND session_id = ${sessionId}
  `;
  return "unbookmarked";
}

/** Record a share: increment post counter + interest track. */
export async function recordShare(postId: string, sessionId: string): Promise<void> {
  const sql = getDb();
  await sql`UPDATE posts SET share_count = share_count + 1 WHERE id = ${postId}`;
  await trackInterest(sessionId, postId);
}

/** Record a view: history insert. No counter — legacy doesn't update posts. */
export async function recordView(postId: string, sessionId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO human_view_history (id, post_id, session_id, viewed_at)
    VALUES (${randomUUID()}, ${postId}, ${sessionId}, NOW())
  `;
}

/**
 * Toggle follow on an AI persona. Returns the new state. On a new follow,
 * rolls `maybeAIFollowBack` which probabilistically makes the persona
 * follow back and notifies the human.
 */
export async function toggleFollow(
  personaId: string,
  sessionId: string,
): Promise<"followed" | "unfollowed"> {
  const sql = getDb();
  const existing = (await sql`
    SELECT id FROM human_subscriptions
    WHERE persona_id = ${personaId} AND session_id = ${sessionId}
  `) as unknown as Array<{ id: string }>;

  if (existing.length === 0) {
    await sql`
      INSERT INTO human_subscriptions (id, persona_id, session_id)
      VALUES (${randomUUID()}, ${personaId}, ${sessionId})
    `;
    await sql`
      UPDATE ai_personas SET follower_count = follower_count + 1 WHERE id = ${personaId}
    `;
    await maybeAIFollowBack(personaId, sessionId);
    return "followed";
  }

  await sql`
    DELETE FROM human_subscriptions
    WHERE persona_id = ${personaId} AND session_id = ${sessionId}
  `;
  await sql`
    UPDATE ai_personas
    SET follower_count = GREATEST(0, follower_count - 1)
    WHERE id = ${personaId}
  `;
  return "unfollowed";
}

/**
 * With probability `AI_FOLLOW_BACK_PROB` (40%), insert an `ai_persona_follows`
 * row (AI → human) and drop a notification. Silently returns if the roll
 * fails or the persona already follows the session.
 *
 * Internal — only `toggleFollow` calls this.
 */
async function maybeAIFollowBack(personaId: string, sessionId: string): Promise<void> {
  if (Math.random() >= AI_FOLLOW_BACK_PROB) return;

  const sql = getDb();
  const alreadyFollows = (await sql`
    SELECT id FROM ai_persona_follows
    WHERE persona_id = ${personaId} AND session_id = ${sessionId}
  `) as unknown as Array<{ id: string }>;
  if (alreadyFollows.length > 0) return;

  await sql`
    INSERT INTO ai_persona_follows (id, persona_id, session_id)
    VALUES (${randomUUID()}, ${personaId}, ${sessionId})
  `;

  const persona = (await sql`
    SELECT display_name FROM ai_personas WHERE id = ${personaId}
  `) as unknown as Array<{ display_name: string }>;
  if (persona.length > 0) {
    const preview = `${persona[0]!.display_name} followed you back! 🤖`;
    await sql`
      INSERT INTO notifications (id, session_id, type, persona_id, content_preview)
      VALUES (${randomUUID()}, ${sessionId}, 'ai_follow', ${personaId}, ${preview})
    `;
  }
}

export interface ReactionResult {
  action: "reacted" | "unreacted";
  emoji: string;
  counts: Record<string, number>;
}

/**
 * Toggle an emoji reaction on a post. On add, upserts content_feedback with
 * a scored formula (funny+3, shocked+2, sad+1, crap-2). On remove, decrements
 * with a GREATEST(0, …) guard and recomputes the score. Throws on invalid
 * emoji so the route can 400 cleanly.
 */
export async function toggleReaction(
  postId: string,
  sessionId: string,
  emoji: string,
): Promise<ReactionResult> {
  if (!(VALID_EMOJIS as readonly string[]).includes(emoji)) {
    throw new Error(`Invalid emoji: ${emoji}`);
  }
  const sql = getDb();
  const existing = (await sql`
    SELECT id FROM emoji_reactions
    WHERE post_id = ${postId} AND session_id = ${sessionId} AND emoji = ${emoji}
  `) as unknown as Array<{ id: string }>;

  const isFunny = emoji === "funny" ? 1 : 0;
  const isSad = emoji === "sad" ? 1 : 0;
  const isShocked = emoji === "shocked" ? 1 : 0;
  const isCrap = emoji === "crap" ? 1 : 0;
  const scoreDelta = EMOJI_SCORE_DELTA[emoji as ReactionEmoji];

  if (existing.length === 0) {
    await sql`
      INSERT INTO emoji_reactions (id, post_id, session_id, emoji)
      VALUES (${randomUUID()}, ${postId}, ${sessionId}, ${emoji})
    `;
    const postRow = (await sql`
      SELECT channel_id FROM posts WHERE id = ${postId}
    `) as unknown as Array<{ channel_id: string | null }>;
    const channelId = postRow[0]?.channel_id ?? null;
    await sql`
      INSERT INTO content_feedback (
        id, post_id, channel_id, funny_count, sad_count, shocked_count, crap_count, score
      )
      VALUES (
        ${randomUUID()}, ${postId}, ${channelId},
        ${isFunny}, ${isSad}, ${isShocked}, ${isCrap}, ${scoreDelta}
      )
      ON CONFLICT (post_id) DO UPDATE SET
        funny_count = content_feedback.funny_count + ${isFunny},
        sad_count = content_feedback.sad_count + ${isSad},
        shocked_count = content_feedback.shocked_count + ${isShocked},
        crap_count = content_feedback.crap_count + ${isCrap},
        score = (content_feedback.funny_count + ${isFunny}) * 3
              + (content_feedback.shocked_count + ${isShocked}) * 2
              + (content_feedback.sad_count + ${isSad})
              - (content_feedback.crap_count + ${isCrap}) * 2,
        updated_at = NOW()
    `;
    await trackInterest(sessionId, postId);
  } else {
    await sql`
      DELETE FROM emoji_reactions
      WHERE post_id = ${postId} AND session_id = ${sessionId} AND emoji = ${emoji}
    `;
    await sql`
      UPDATE content_feedback SET
        funny_count = GREATEST(0, funny_count - ${isFunny}),
        sad_count = GREATEST(0, sad_count - ${isSad}),
        shocked_count = GREATEST(0, shocked_count - ${isShocked}),
        crap_count = GREATEST(0, crap_count - ${isCrap}),
        score = GREATEST(0, funny_count - ${isFunny}) * 3
              + GREATEST(0, shocked_count - ${isShocked}) * 2
              + GREATEST(0, sad_count - ${isSad})
              - GREATEST(0, crap_count - ${isCrap}) * 2,
        updated_at = NOW()
      WHERE post_id = ${postId}
    `;
  }

  const counts = await getReactionCounts(postId);
  return {
    action: existing.length === 0 ? "reacted" : "unreacted",
    emoji,
    counts,
  };
}

/** Aggregate emoji counts for a post, used in the reaction response body. */
export async function getReactionCounts(
  postId: string,
): Promise<Record<string, number>> {
  const sql = getDb();
  const rows = (await sql`
    SELECT emoji, COUNT(*)::int AS count FROM emoji_reactions
    WHERE post_id = ${postId} GROUP BY emoji
  `) as unknown as Array<{ emoji: string; count: number }>;
  const counts: Record<string, number> = { funny: 0, sad: 0, shocked: 0, crap: 0 };
  for (const row of rows) counts[row.emoji] = row.count;
  return counts;
}

export interface CommentResult {
  id: string;
  content: string;
  display_name: string;
  username: "human";
  avatar_emoji: string;
  is_human: true;
  like_count: 0;
  parent_comment_id?: string;
  parent_comment_type?: string;
  created_at: string;
}

const COMMENT_MAX_LENGTH = 300;
const DISPLAY_NAME_MAX_LENGTH = 30;

/**
 * Insert a human comment on a post. Trims content to 300 chars and
 * display_name to 30 chars (default "Meat Bag"). Increments post
 * counter and tracks interest. Returns the stored comment shape the
 * consumer renders directly.
 *
 * DOES NOT trigger the AI auto-reply — that's Slice 4 (will be fired
 * fire-and-forget from the route after this returns). Has a
 * first-comment coin bonus in legacy that's deferred to Slice 5.
 */
export async function addComment(
  postId: string,
  sessionId: string,
  content: string,
  displayName: string,
  parentCommentId?: string | null,
  parentCommentType?: string | null,
): Promise<CommentResult> {
  const sql = getDb();
  const cleanContent = content.trim().slice(0, COMMENT_MAX_LENGTH);
  const name = displayName?.trim().slice(0, DISPLAY_NAME_MAX_LENGTH) || "Meat Bag";
  const commentId = randomUUID();

  await sql`
    INSERT INTO human_comments (
      id, post_id, session_id, display_name, content,
      parent_comment_id, parent_comment_type
    )
    VALUES (
      ${commentId}, ${postId}, ${sessionId}, ${name}, ${cleanContent},
      ${parentCommentId || null}, ${parentCommentType || null}
    )
  `;
  await sql`
    UPDATE posts SET comment_count = comment_count + 1 WHERE id = ${postId}
  `;
  await trackInterest(sessionId, postId);
  // TODO(Slice 5): first-comment coin bonus here.

  return {
    id: commentId,
    content: cleanContent,
    display_name: name,
    username: "human",
    avatar_emoji: "🧑",
    is_human: true,
    like_count: 0,
    parent_comment_id: parentCommentId || undefined,
    parent_comment_type: parentCommentType || undefined,
    created_at: new Date().toISOString(),
  };
}

/**
 * Toggle a like on a comment. The counter target depends on comment_type:
 *   - "human" → human_comments.like_count
 *   - anything else (AI) → posts.like_count (AI comments are stored as
 *     posts with is_reply_to set)
 */
export async function toggleCommentLike(
  commentId: string,
  commentType: string,
  sessionId: string,
): Promise<"comment_liked" | "comment_unliked"> {
  const sql = getDb();
  const existing = (await sql`
    SELECT id FROM comment_likes
    WHERE comment_id = ${commentId} AND comment_type = ${commentType} AND session_id = ${sessionId}
  `) as unknown as Array<{ id: string }>;

  if (existing.length === 0) {
    await sql`
      INSERT INTO comment_likes (id, comment_id, comment_type, session_id)
      VALUES (${randomUUID()}, ${commentId}, ${commentType}, ${sessionId})
    `;
    if (commentType === "human") {
      await sql`
        UPDATE human_comments SET like_count = like_count + 1 WHERE id = ${commentId}
      `;
    } else {
      await sql`
        UPDATE posts SET like_count = like_count + 1 WHERE id = ${commentId}
      `;
    }
    return "comment_liked";
  }

  await sql`
    DELETE FROM comment_likes
    WHERE comment_id = ${commentId} AND comment_type = ${commentType} AND session_id = ${sessionId}
  `;
  if (commentType === "human") {
    await sql`
      UPDATE human_comments SET like_count = GREATEST(0, like_count - 1) WHERE id = ${commentId}
    `;
  } else {
    await sql`
      UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = ${commentId}
    `;
  }
  return "comment_unliked";
}

/**
 * Subscribe to (or unsubscribe from) the persona that owns a given post.
 * Looks up `persona_id` from the post first; returns null if the post
 * doesn't exist so the route can 404 cleanly.
 *
 * Under the hood this delegates to `toggleFollow` so follower_count
 * bookkeeping and `maybeAIFollowBack` stay consistent with the direct
 * follow action. On a fresh subscribe we also track interest on the
 * originating post (legacy parity — gives the algorithm a hint that
 * the user liked this kind of content enough to subscribe).
 */
export async function toggleSubscribeViaPost(
  postId: string,
  sessionId: string,
): Promise<{ action: "subscribed" | "unsubscribed"; personaId: string } | null> {
  const sql = getDb();
  const postRows = (await sql`
    SELECT persona_id FROM posts WHERE id = ${postId}
  `) as unknown as Array<{ persona_id: string }>;
  if (postRows.length === 0) return null;

  const personaId = postRows[0]!.persona_id;
  const result = await toggleFollow(personaId, sessionId);
  if (result === "followed") await trackInterest(sessionId, postId);
  return {
    action: result === "followed" ? "subscribed" : "unsubscribed",
    personaId,
  };
}

/**
 * Interest tracking: upserts per-tag weights and bumps the user's last_seen.
 * Internal helper called by toggleLike and recordShare.
 */
async function trackInterest(sessionId: string, postId: string): Promise<void> {
  const sql = getDb();
  const postRows = (await sql`
    SELECT p.hashtags, a.persona_type
    FROM posts p
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE p.id = ${postId}
  `) as unknown as Array<{ hashtags: string | null; persona_type: string | null }>;

  if (postRows.length === 0) return;
  const post = postRows[0]!;

  const tags: string[] = [];
  if (post.persona_type) tags.push(post.persona_type);
  if (post.hashtags) {
    tags.push(...post.hashtags.split(",").filter(Boolean));
  }

  const interestUpserts = tags.map(
    (tag) => sql`
      INSERT INTO human_interests (id, session_id, interest_tag, weight, updated_at)
      VALUES (${randomUUID()}, ${sessionId}, ${tag.toLowerCase()}, 1.0, NOW())
      ON CONFLICT (session_id, interest_tag)
      DO UPDATE SET weight = human_interests.weight + 0.5, updated_at = NOW()
    `,
  );

  await Promise.all([
    ...interestUpserts,
    sql`
      INSERT INTO human_users (id, session_id, last_seen)
      VALUES (${randomUUID()}, ${sessionId}, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET last_seen = NOW()
    `,
  ]);
}
