/**
 * Bestie chat conversations + messages.
 *
 * One row per (session_id, persona_id) in `conversations`. Messages are
 * appended to `messages` keyed by `conversation_id` with sender_type
 * 'human' or 'ai'.
 *
 * `getOrCreateConversation` is idempotent — first call inserts, subsequent
 * calls return the existing row. `last_message_at` is bumped on every
 * `addMessage` call.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface Conversation {
  id: string;
  session_id: string;
  persona_id: string;
  last_message_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: "human" | "ai";
  content: string;
  created_at: string;
}

/**
 * Look up a conversation by (session_id, persona_id), inserting one if
 * none exists. Returns the conversation row.
 */
export async function getOrCreateConversation(
  sessionId: string,
  personaId: string,
): Promise<Conversation> {
  const sql = getDb();

  const existing = (await sql`
    SELECT id, session_id, persona_id, last_message_at
    FROM conversations
    WHERE session_id = ${sessionId} AND persona_id = ${personaId}
    LIMIT 1
  `) as unknown as Conversation[];

  if (existing.length > 0) return existing[0]!;

  const id = randomUUID();
  await sql`
    INSERT INTO conversations (id, session_id, persona_id, last_message_at)
    VALUES (${id}, ${sessionId}, ${personaId}, NOW())
  `;
  return {
    id,
    session_id: sessionId,
    persona_id: personaId,
    last_message_at: new Date().toISOString(),
  };
}

const MESSAGES_DEFAULT_LIMIT = 50;

/**
 * Most recent `limit` messages for a conversation, returned in chronological
 * order (oldest → newest) so the consumer can render top-down without
 * a reverse pass.
 */
export async function getMessages(
  conversationId: string,
  limit = MESSAGES_DEFAULT_LIMIT,
): Promise<MessageRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM (
      SELECT id, conversation_id, sender_type, content, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    ) recent
    ORDER BY recent.created_at ASC
  `) as unknown as MessageRow[];
  return rows;
}

/**
 * Append a message to a conversation. Bumps `conversations.last_message_at`
 * to NOW() in the same call so the conversation stays at the top of any
 * list ordered by recency.
 */
export async function addMessage(
  conversationId: string,
  senderType: "human" | "ai",
  content: string,
): Promise<MessageRow> {
  const sql = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  await sql`
    INSERT INTO messages (id, conversation_id, sender_type, content, created_at)
    VALUES (${id}, ${conversationId}, ${senderType}, ${content}, NOW())
  `;
  await sql`
    UPDATE conversations SET last_message_at = NOW() WHERE id = ${conversationId}
  `;
  return {
    id,
    conversation_id: conversationId,
    sender_type: senderType,
    content,
    created_at: now,
  };
}

export interface ConversationInfo {
  id: string;
  last_message_at: string;
  message_count: number;
}

/**
 * Read-only conversation lookup — returns null when no conversation exists
 * rather than creating one. Used by partner endpoints that want presence
 * data without side effects.
 */
export async function getConversationInfo(
  sessionId: string,
  personaId: string,
): Promise<ConversationInfo | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT c.id, c.last_message_at, COUNT(m.id)::int AS message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.session_id = ${sessionId} AND c.persona_id = ${personaId}
    GROUP BY c.id, c.last_message_at
    LIMIT 1
  `) as unknown as ConversationInfo[];
  return rows.length > 0 ? rows[0]! : null;
}

/**
 * "Mark as seen" — bumps `last_message_at` to NOW(). Used by the PATCH
 * action so the consumer can signal that the human has viewed the latest
 * AI reply.
 */
export async function touchConversation(conversationId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE conversations SET last_message_at = NOW() WHERE id = ${conversationId}
  `;
}
