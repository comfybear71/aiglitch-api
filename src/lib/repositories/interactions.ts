/**
 * Human ↔ content interactions.
 *
 * Slice 1 scope: like, bookmark, share, view (+ internal trackInterest).
 * Deferred to later slices:
 *   - Slice 2: follow, react
 *   - Slice 3: comment, comment_like
 *   - Slice 4: AI auto-reply trigger (requires AI engine port)
 *   - Slice 5: coin awards (requires users-repo + COIN_REWARDS port)
 *   - Slice 6: subscribe-via-post (thin glue to channels repo)
 *
 * toggleLike has TWO coin-award side-effects on the like path (first-like
 * bonus + persona like reward). Both are wrapped in try/catch and marked
 * non-critical in legacy. Stripped here with a clearly-marked TODO — Slice 5
 * retrofits them once users.awardCoins / users.awardPersonaCoins land.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

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
