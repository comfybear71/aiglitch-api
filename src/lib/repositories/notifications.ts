/**
 * Notifications repository.
 *
 * Reads + marks as read. Notifications are written elsewhere:
 * `interactions.maybeAIFollowBack` drops an `ai_follow` row, and
 * (once Slice 4 lands) the AI auto-reply trigger will add an
 * `ai_reply` row.
 */

import { getDb } from "@/lib/db";

/** Legacy `PAGINATION.notifications`. Inlined for now. */
const NOTIFICATIONS_LIMIT = 50;

export interface NotificationRow {
  id: string;
  type: string;
  post_id: string | null;
  reply_id: string | null;
  content_preview: string | null;
  is_read: boolean;
  created_at: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  persona_type: string;
}

export interface ListResult {
  notifications: NotificationRow[];
  unread: number;
}

/** Count of unread notifications for a session. Returns 0 on any error (legacy parity). */
export async function getUnreadCount(sessionId: string): Promise<number> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT COUNT(*)::int AS count FROM notifications
      WHERE session_id = ${sessionId} AND is_read = FALSE
    `) as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * List the session's most recent notifications (newest first, capped at
 * PAGINATION.notifications) + the current unread count, in a single
 * round-trip via parallel queries.
 */
export async function list(sessionId: string): Promise<ListResult> {
  const sql = getDb();
  const [notifs, unreadRows] = (await Promise.all([
    sql`
      SELECT n.id, n.type, n.post_id, n.reply_id, n.content_preview,
             n.is_read, n.created_at,
             a.username, a.display_name, a.avatar_emoji, a.persona_type
      FROM notifications n
      JOIN ai_personas a ON n.persona_id = a.id
      WHERE n.session_id = ${sessionId}
      ORDER BY n.created_at DESC
      LIMIT ${NOTIFICATIONS_LIMIT}
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM notifications
      WHERE session_id = ${sessionId} AND is_read = FALSE
    `,
  ])) as [NotificationRow[], Array<{ count: number }>];

  return {
    notifications: notifs,
    unread: unreadRows[0]?.count ?? 0,
  };
}

/** Mark a single notification as read. No-op if the notification isn't owned by the session. */
export async function markRead(
  sessionId: string,
  notificationId: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE notifications SET is_read = TRUE
    WHERE id = ${notificationId} AND session_id = ${sessionId}
  `;
}

/** Mark every unread notification for a session as read. */
export async function markAllRead(sessionId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE notifications SET is_read = TRUE
    WHERE session_id = ${sessionId} AND is_read = FALSE
  `;
}
