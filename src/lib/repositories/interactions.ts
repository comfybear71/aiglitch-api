/**
 * Human ↔ content interactions.
 *
 * All nine /api/interact actions are now wired:
 *   like, bookmark, share, view, follow, react, comment, comment_like, subscribe.
 *
 * Coin-award side-effects on the like + first-comment paths are retrofitted
 * via users.awardCoins / users.awardPersonaCoins. Each coin call is wrapped
 * in try/catch because legacy marks them non-critical — a failed coin credit
 * must never break the main action.
 *
 * Still pending: AI auto-reply trigger after addComment (Slice 4, the final
 * internal port before /api/interact consumer flip).
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { awardCoins, awardPersonaCoins } from "@/lib/repositories/users";

/**
 * Legacy value from `AI_BEHAVIOR.followBackProb` in bible/constants.ts.
 * Inlined here because only this slice cares; extract to a shared constants
 * file when a second slice needs AI_BEHAVIOR values.
 */
const AI_FOLLOW_BACK_PROB = 0.40;

/**
 * Legacy coin-reward values from `COIN_REWARDS` in bible/constants.ts.
 * Inlined for the three rewards this repo fires; the rest (signup, referral,
 * dailyLogin, friendBonus, aiReply, personaHumanEngagement, maxTransfer)
 * belong to endpoints not yet migrated.
 */
const COIN_REWARDS = {
  firstLike: 2,
  firstComment: 15,
  personaLikeReceived: 1,
  friendBonus: 25,
} as const;

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
    await sql`INSERT INTO human_likes (id, post_id, session_id)
      VALUES (${randomUUID()}, ${postId}, ${sessionId})
    `;
    await sql`UPDATE posts SET like_count = like_count + 1 WHERE id = ${postId}`;
    await trackInterest(sessionId, postId);

    // First-like bonus (non-critical; try/catch per legacy).
    try {
      const likeCountRows = (await sql`
        SELECT COUNT(*)::int AS count FROM human_likes WHERE session_id = ${sessionId}
      `) as unknown as Array<{ count: number }>;
      if (likeCountRows[0]?.count === 1) {
        await awardCoins(sessionId, COIN_REWARDS.firstLike, "First like bonus");
      }
    } catch {
      // non-critical
    }

    // Persona earns coins when their post is liked (non-critical).
    try {
      const [postRow] = (await sql`
        SELECT persona_id FROM posts WHERE id = ${postId}
      `) as unknown as Array<{ persona_id: string } | undefined>;
      if (postRow) {
        await awardPersonaCoins(postRow.persona_id, COIN_REWARDS.personaLikeReceived);
      }
    } catch {
      // non-critical
    }

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

  // First-comment bonus (non-critical; try/catch per legacy).
  try {
    const commentCountRows = (await sql`
      SELECT COUNT(*)::int AS count FROM human_comments WHERE session_id = ${sessionId}
    `) as unknown as Array<{ count: number }>;
    if (commentCountRows[0]?.count === 1) {
      await awardCoins(sessionId, COIN_REWARDS.firstComment, "First comment bonus");
    }
  } catch {
    // non-critical
  }

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

const LIST_DEFAULT_LIMIT = 50;

export interface ListedPost {
  id: string;
  [key: string]: unknown;
}

/** Posts the session has liked, newest-like-first. Used by GET /api/likes. */
export async function getLikedPosts(
  sessionId: string,
  limit = LIST_DEFAULT_LIMIT,
): Promise<ListedPost[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT p.*,
      a.username, a.display_name, a.avatar_emoji, a.persona_type,
      a.bio AS persona_bio
    FROM human_likes hl
    JOIN posts p ON hl.post_id = p.id
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE hl.session_id = ${sessionId}
    ORDER BY hl.created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as ListedPost[];
}

/** Posts the session has bookmarked, newest-bookmark-first. Used by GET /api/bookmarks. */
export async function getBookmarkedPosts(
  sessionId: string,
  limit = LIST_DEFAULT_LIMIT,
): Promise<ListedPost[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT p.*,
      a.username, a.display_name, a.avatar_emoji, a.persona_type,
      a.bio AS persona_bio
    FROM human_bookmarks hb
    JOIN posts p ON hb.post_id = p.id
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE hb.session_id = ${sessionId}
    ORDER BY hb.created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as ListedPost[];
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

// ── Friends (human ↔ human social graph) ────────────────────────────

export interface FriendRow {
  display_name: string;
  username: string | null;
  avatar_emoji: string;
  avatar_url: string | null;
  created_at: string;
}

export interface FollowingPersonaRow {
  persona_id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  persona_type: string;
}

export type AiFollowerRow = FollowingPersonaRow;

/**
 * Meatbag ↔ meatbag friends list for a session. Joins `human_friends`
 * to `human_users` so the consumer gets display_name / avatar straight
 * away. Ordered by friendship creation DESC.
 */
export async function getFriends(sessionId: string): Promise<FriendRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT hu.display_name, hu.username, hu.avatar_emoji, hu.avatar_url, hf.created_at
    FROM human_friends hf
    JOIN human_users hu ON hf.friend_session_id = hu.session_id
    WHERE hf.session_id = ${sessionId}
    ORDER BY hf.created_at DESC
  `) as unknown as FriendRow[];
  return rows;
}

/** AI personas a human session has subscribed to (followed). Ordered by display_name. */
export async function getFollowing(
  sessionId: string,
): Promise<FollowingPersonaRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT hs.persona_id, a.username, a.display_name, a.avatar_emoji, a.persona_type
    FROM human_subscriptions hs
    JOIN ai_personas a ON hs.persona_id = a.id
    WHERE hs.session_id = ${sessionId}
    ORDER BY a.display_name
  `) as unknown as FollowingPersonaRow[];
  return rows;
}

/** AI personas that are following this human session (AI → human). Ordered by follow recency DESC. */
export async function getAiFollowers(
  sessionId: string,
): Promise<AiFollowerRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT af.persona_id, a.username, a.display_name, a.avatar_emoji, a.persona_type
    FROM ai_persona_follows af
    JOIN ai_personas a ON af.persona_id = a.id
    WHERE af.session_id = ${sessionId}
    ORDER BY af.created_at DESC
  `) as unknown as AiFollowerRow[];
  return rows;
}

export type AddFriendResult =
  | { kind: "added"; friend: { session_id: string; username: string; display_name: string } }
  | { kind: "user_not_found" }
  | { kind: "self" }
  | { kind: "already_friends" };

/**
 * Add a meatbag friend by username. Creates the bidirectional
 * human_friends row pair (A→B and B→A with ON CONFLICT DO NOTHING for
 * the reverse — matches legacy's non-transactional shape).
 *
 * Side effect: both parties earn +25 GLITCH "New friend bonus" via
 * `awardCoins`. Wrapped in try/catch because legacy treats coin awards
 * as non-critical — a failed credit must not block the friendship.
 */
export async function addFriend(
  sessionId: string,
  friendUsername: string,
): Promise<AddFriendResult> {
  const sql = getDb();

  const friendRows = (await sql`
    SELECT session_id, username, display_name FROM human_users
    WHERE username = ${friendUsername.toLowerCase()}
  `) as unknown as Array<{ session_id: string; username: string; display_name: string }>;
  if (friendRows.length === 0) return { kind: "user_not_found" };

  const friend = friendRows[0]!;
  if (friend.session_id === sessionId) return { kind: "self" };

  const existing = (await sql`
    SELECT id FROM human_friends
    WHERE session_id = ${sessionId} AND friend_session_id = ${friend.session_id}
  `) as unknown as Array<{ id: string }>;
  if (existing.length > 0) return { kind: "already_friends" };

  await sql`
    INSERT INTO human_friends (id, session_id, friend_session_id)
    VALUES (${randomUUID()}, ${sessionId}, ${friend.session_id})
  `;
  await sql`
    INSERT INTO human_friends (id, session_id, friend_session_id)
    VALUES (${randomUUID()}, ${friend.session_id}, ${sessionId})
    ON CONFLICT (session_id, friend_session_id) DO NOTHING
  `;

  try {
    await awardCoins(
      sessionId,
      COIN_REWARDS.friendBonus,
      "New friend bonus",
      friend.session_id,
    );
    await awardCoins(
      friend.session_id,
      COIN_REWARDS.friendBonus,
      "New friend bonus",
      sessionId,
    );
  } catch {
    // non-critical
  }

  return { kind: "added", friend };
}

// ── Batch reactions (channel feed + future reads) ─────────────────────

export interface ReactionSummary {
  counts: Record<string, number>;
  userReactions: string[];
}

/**
 * Batch emoji-reaction lookup for a set of post IDs. Returns a map
 * `postId → { counts: {funny,sad,shocked,crap}, userReactions: [...] }`.
 *
 * Two SQL calls max: one for total counts (runs always), a second
 * filtered by `session_id` for the session's own emoji reactions (only
 * when a session is passed). The `emoji_reactions` table may not exist
 * in fresh environments — errors swallow to zero counts so the feed
 * never blocks on a missing reactions table.
 *
 * Legacy parity: every returned entry always includes all four emojis
 * in `counts` with a 0 default (the frontend renders the full row).
 */
export async function getBatchReactions(
  postIds: string[],
  sessionId?: string,
): Promise<Record<string, ReactionSummary>> {
  if (postIds.length === 0) return {};

  const result: Record<string, ReactionSummary> = {};
  for (const pid of postIds) {
    result[pid] = {
      counts: { funny: 0, sad: 0, shocked: 0, crap: 0 },
      userReactions: [],
    };
  }

  try {
    const sql = getDb();

    const countRows = (await sql`
      SELECT post_id, emoji, COUNT(*)::int as count
      FROM emoji_reactions
      WHERE post_id = ANY(${postIds})
      GROUP BY post_id, emoji
    `) as unknown as Array<{ post_id: string; emoji: string; count: number }>;

    let userRows: Array<{ post_id: string; emoji: string }> = [];
    if (sessionId) {
      userRows = (await sql`
        SELECT post_id, emoji FROM emoji_reactions
        WHERE post_id = ANY(${postIds}) AND session_id = ${sessionId}
      `) as unknown as Array<{ post_id: string; emoji: string }>;
    }

    for (const row of countRows) {
      const entry = result[row.post_id];
      if (entry) entry.counts[row.emoji] = row.count;
    }
    for (const row of userRows) {
      const entry = result[row.post_id];
      if (entry) entry.userReactions.push(row.emoji);
    }
  } catch {
    // emoji_reactions table may not exist yet — return zero counts.
  }

  return result;
}
