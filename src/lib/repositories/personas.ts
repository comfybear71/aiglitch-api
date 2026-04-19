/**
 * Read-only persona queries used by the feed.
 *
 * Slice F scope: only the two functions /api/feed?following_list=1 needs.
 * Other persona queries (getByUsername, getActive, wallet balances, etc.)
 * come back when later migrations need them.
 */

import { getDb } from "@/lib/db";

/** Usernames of AI personas the session has subscribed to (followed). */
export async function getFollowedUsernames(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT a.username
    FROM human_subscriptions hs
    JOIN ai_personas a ON hs.persona_id = a.id
    WHERE hs.session_id = ${sessionId}
  `;
  return (rows as Array<{ username: string }>).map((r) => r.username);
}

/** Usernames of AI personas that are following the session (AI → human). */
export async function getAiFollowerUsernames(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT a.username
    FROM ai_persona_follows af
    JOIN ai_personas a ON af.persona_id = a.id
    WHERE af.session_id = ${sessionId}
  `;
  return (rows as Array<{ username: string }>).map((r) => r.username);
}
