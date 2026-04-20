/**
 * Partner / mobile-app repositories.
 *
 * Push-token registration and briefing aggregation for the iOS G!itch Bestie app.
 *
 * `device_push_tokens` table is new to this repo (not in the legacy schema).
 * The CREATE TABLE IF NOT EXISTS guard runs once per module load, harmlessly
 * no-ops if the table already exists from a prior cold start.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

// ─── Push tokens ─────────────────────────────────────────────────────────────

let pushTableEnsured = false;

async function ensurePushTokensTable(): Promise<void> {
  if (pushTableEnsured) return;
  pushTableEnsured = true;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS device_push_tokens (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id  TEXT         NOT NULL,
      token       TEXT         NOT NULL,
      platform    TEXT         NOT NULL DEFAULT 'ios',
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (token)
    )
  `;
}

/** @internal test helper — resets the migration flag between test runs */
export function __resetPushTableFlag(): void {
  pushTableEnsured = false;
}

/**
 * Upsert a push notification token. On conflict (same token) the session_id,
 * platform, and updated_at are refreshed so a re-install on the same device
 * stays current.
 */
export async function registerPushToken(
  sessionId: string,
  token: string,
  platform = "ios",
): Promise<void> {
  await ensurePushTokensTable();
  const sql = getDb();
  await sql`
    INSERT INTO device_push_tokens (id, session_id, token, platform, created_at, updated_at)
    VALUES (${randomUUID()}, ${sessionId}, ${token}, ${platform}, NOW(), NOW())
    ON CONFLICT (token) DO UPDATE
      SET session_id = EXCLUDED.session_id,
          platform   = EXCLUDED.platform,
          updated_at = NOW()
  `;
}

// ─── Briefing ────────────────────────────────────────────────────────────────

export interface BriefingConversation {
  conversation_id: string;
  persona_id: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  last_message_at: string;
  last_message: string | null;
  last_sender_type: string | null;
}

export interface BriefingData {
  followed_count: number;
  unread_notifications: number;
  conversations: BriefingConversation[];
}

/**
 * Aggregated home-screen data for the iOS app. Three sequential queries:
 * follow count, unread notification count, and recent bestie conversations
 * with a last-message preview.
 */
export async function getBriefingData(sessionId: string): Promise<BriefingData> {
  const sql = getDb();

  const followedRows = (await sql`
    SELECT COUNT(*)::int AS count
    FROM human_subscriptions
    WHERE session_id = ${sessionId}
  `) as unknown as Array<{ count: number }>;

  const notifRows = (await sql`
    SELECT COUNT(*)::int AS count
    FROM notifications
    WHERE session_id = ${sessionId} AND is_read = FALSE
  `) as unknown as Array<{ count: number }>;

  const convRows = (await sql`
    SELECT
      c.id              AS conversation_id,
      c.persona_id,
      c.last_message_at,
      p.display_name,
      p.avatar_emoji,
      p.avatar_url,
      (
        SELECT content
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS last_message,
      (
        SELECT sender_type
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS last_sender_type
    FROM conversations c
    JOIN ai_personas p ON p.id = c.persona_id
    WHERE c.session_id = ${sessionId}
    ORDER BY c.last_message_at DESC
    LIMIT 5
  `) as unknown as BriefingConversation[];

  return {
    followed_count: followedRows[0]?.count ?? 0,
    unread_notifications: notifRows[0]?.count ?? 0,
    conversations: convRows,
  };
}
