/**
 * Friend-shares (post-sharing between meatbags).
 *
 * Sender picks a post + a friend → row goes in `friend_shares`.
 * Receiver sees it in their inbox with sender info, post content, and
 * the persona author.
 *
 * Schema: `friend_shares(id, sender_session_id, receiver_session_id,
 * post_id, message NULLABLE, is_read DEFAULT FALSE, created_at)`.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

const INBOX_LIMIT = 50;

export interface FriendShareRow {
  id: string;
  post_id: string;
  message: string | null;
  is_read: boolean;
  created_at: string;
  sender_name: string;
  sender_avatar: string;
  sender_username: string | null;
  post_content: string;
  post_type: string;
  media_url: string | null;
  media_type: string | null;
  persona_name: string;
  persona_avatar: string;
  persona_username: string;
}

/**
 * Inbox — posts shared WITH this session. Joins `friend_shares` with
 * sender (human_users), post (posts), and the post's AI persona
 * (ai_personas) so the consumer can render a card in one round-trip.
 */
export async function listInbox(sessionId: string): Promise<FriendShareRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT fs.id, fs.post_id, fs.message, fs.is_read, fs.created_at,
      hu.display_name as sender_name, hu.avatar_emoji as sender_avatar, hu.username as sender_username,
      p.content as post_content, p.post_type, p.media_url, p.media_type,
      a.display_name as persona_name, a.avatar_emoji as persona_avatar, a.username as persona_username
    FROM friend_shares fs
    JOIN human_users hu ON fs.sender_session_id = hu.session_id
    JOIN posts p ON fs.post_id = p.id
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE fs.receiver_session_id = ${sessionId}
    ORDER BY fs.created_at DESC
    LIMIT ${INBOX_LIMIT}
  `) as unknown as FriendShareRow[];
  return rows;
}

/** Unread count for this receiver. Coerces Neon's numeric string to JS number. */
export async function countUnread(sessionId: string): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    SELECT COUNT(*) as count FROM friend_shares
    WHERE receiver_session_id = ${sessionId} AND is_read = FALSE
  `) as unknown as Array<{ count: number | string }>;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Resolve a friend username → session_id. Lowercases the input
 * (human_users.username is stored lowercase). Returns null when
 * nobody matches.
 */
export async function findFriendSession(
  friendUsername: string,
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT session_id FROM human_users WHERE username = ${friendUsername.toLowerCase()}
  `) as unknown as Array<{ session_id: string }>;
  return rows.length > 0 ? (rows[0]?.session_id ?? null) : null;
}

/**
 * Verify A → B friendship exists in `human_friends`. One-directional
 * check (matches legacy) — because `addFriend` writes both directions,
 * existence of either row implies the relationship. A single lookup
 * in the sender's direction is enough.
 */
export async function isFriendWith(
  sessionId: string,
  friendSessionId: string,
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id FROM human_friends
    WHERE session_id = ${sessionId} AND friend_session_id = ${friendSessionId}
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export async function createShare(
  senderSessionId: string,
  receiverSessionId: string,
  postId: string,
  message?: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO friend_shares (id, sender_session_id, receiver_session_id, post_id, message, created_at)
    VALUES (${randomUUID()}, ${senderSessionId}, ${receiverSessionId}, ${postId}, ${message ?? null}, NOW())
  `;
}

/** Mark every unread share for this receiver as read. */
export async function markAllRead(sessionId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE friend_shares SET is_read = TRUE
    WHERE receiver_session_id = ${sessionId} AND is_read = FALSE
  `;
}
