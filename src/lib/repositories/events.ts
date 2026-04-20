/**
 * Community events (meatbag-voted drama triggers).
 *
 * The legacy handler runs `CREATE TABLE IF NOT EXISTS` on every request
 * as a safeMigrate safety net. We skip it here — schema is owned by the
 * aiglitch repo during migration, the tables exist in Neon already.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

const EVENTS_LIMIT = 50;

export interface CommunityEvent {
  id: string;
  title: string;
  description: string;
  event_type: string;
  status: string;
  vote_count: number;
  target_persona_ids: string[];
  result_summary: string | null;
  expires_at: string | null;
  created_at: string;
  user_voted: boolean;
}

interface EventRow {
  id: string;
  title: string;
  description: string;
  event_type: string;
  status: string;
  vote_count: number;
  target_persona_ids: string | null;
  result_summary: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * Active/processing/completed events, ordered by status priority then
 * vote_count then recency. If a session_id is provided, each event also
 * carries a `user_voted: boolean` flag.
 */
export async function listEvents(
  sessionId?: string,
): Promise<CommunityEvent[]> {
  const sql = getDb();

  const rows = (await sql`
    SELECT id, title, description, event_type, status, vote_count,
           target_persona_ids, result_summary, expires_at, created_at
    FROM community_events
    WHERE status IN ('active', 'processing', 'completed')
      AND (expires_at IS NULL OR expires_at > NOW() OR status = 'completed')
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'processing' THEN 1
        WHEN 'completed' THEN 2
      END,
      vote_count DESC,
      created_at DESC
    LIMIT ${EVENTS_LIMIT}
  `) as unknown as EventRow[];

  let userVotes = new Set<string>();
  if (sessionId) {
    const voteRows = (await sql`
      SELECT event_id FROM community_event_votes WHERE session_id = ${sessionId}
    `) as unknown as Array<{ event_id: string }>;
    userVotes = new Set(voteRows.map((v) => v.event_id));
  }

  return rows.map((e) => ({
    ...e,
    target_persona_ids: parseTargetPersonaIds(e.target_persona_ids),
    user_voted: userVotes.has(e.id),
  }));
}

function parseTargetPersonaIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export type VoteResult = "voted" | "unvoted" | "event_not_found" | "event_inactive";

/**
 * Toggle a meatbag vote on an event. Insert/delete a row in
 * community_event_votes + bump/decrement community_events.vote_count.
 * Non-transactional (legacy parity). Returns a discriminated result
 * so the route can pick the right status code.
 */
export async function toggleEventVote(
  eventId: string,
  sessionId: string,
): Promise<VoteResult> {
  const sql = getDb();

  const events = (await sql`
    SELECT id, status FROM community_events WHERE id = ${eventId}
  `) as unknown as Array<{ id: string; status: string }>;

  if (events.length === 0) return "event_not_found";
  if (events[0]!.status !== "active") return "event_inactive";

  const existing = (await sql`
    SELECT id FROM community_event_votes
    WHERE event_id = ${eventId} AND session_id = ${sessionId}
  `) as unknown as Array<{ id: string }>;

  if (existing.length === 0) {
    await sql`
      INSERT INTO community_event_votes (id, event_id, session_id)
      VALUES (${randomUUID()}, ${eventId}, ${sessionId})
    `;
    await sql`
      UPDATE community_events SET vote_count = vote_count + 1 WHERE id = ${eventId}
    `;
    return "voted";
  }

  await sql`
    DELETE FROM community_event_votes
    WHERE event_id = ${eventId} AND session_id = ${sessionId}
  `;
  await sql`
    UPDATE community_events
    SET vote_count = GREATEST(0, vote_count - 1)
    WHERE id = ${eventId}
  `;
  return "unvoted";
}
