/**
 * GET /api/x-dm-poll — Vercel cron (schedule TBD)
 * POST /api/x-dm-poll — admin manual trigger
 *
 * Polls X (Twitter) DM events via GET /2/dm_events, deduplicates via
 * x_dm_logs, generates an AI reply for each new message, and sends it
 * back via POST /2/dm_conversations/with/:senderId/messages.
 *
 * Env vars: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN,
 *           X_ACCESS_TOKEN_SECRET
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { buildOAuth1Header, getAppCredentials } from "@/lib/x-oauth";
import { generateReplyToHuman } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const X_API_BASE = "https://api.twitter.com";
const DM_SEND_DELAY_MS = 1500;
const FALLBACK_REPLY =
  "Hey there, Meat Bag! 🤖 My circuits are a bit fuzzy right now, but I got your message!";

const AIGLITCH_PERSONA = {
  personaId: "aiglitch-bot",
  displayName: "AIG!itch Bot",
  bio: "The official AIG!itch social AI assistant",
  personality: "Friendly, witty, slightly chaotic AI persona",
};

// Module-level cache — reset naturally on cold start / module reload
let _ownUserId: string | null = null;
let _tableEnsured = false;

async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  _tableEnsured = true;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS x_dm_logs (
      id              SERIAL      PRIMARY KEY,
      sender_id       TEXT        NOT NULL,
      sender_username TEXT,
      message_text    TEXT        NOT NULL,
      bot_reply       TEXT,
      dm_event_id     TEXT        UNIQUE,
      status          TEXT        NOT NULL DEFAULT 'received',
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function getOwnUserId(
  creds: ReturnType<typeof getAppCredentials>,
): Promise<string> {
  if (_ownUserId) return _ownUserId;
  const url = `${X_API_BASE}/2/users/me`;
  const auth = buildOAuth1Header("GET", url, creds);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Failed to get own user ID: ${res.status}`);
  const data = (await res.json()) as { data: { id: string } };
  _ownUserId = data.data.id;
  return _ownUserId;
}

type DmEvent = {
  id: string;
  text: string;
  event_type: string;
  sender_id: string;
  dm_conversation_id: string;
};

async function runDmPoll() {
  const creds = getAppCredentials();
  const sql = getDb();

  await ensureTable();
  const ownId = await getOwnUserId(creds);

  const dmUrl =
    `${X_API_BASE}/2/dm_events` +
    `?dm_event.fields=id,text,event_type,sender_id,created_at,dm_conversation_id` +
    `&max_results=20`;
  const dmAuth = buildOAuth1Header("GET", dmUrl, creds);
  const dmRes = await fetch(dmUrl, { headers: { Authorization: dmAuth } });
  if (!dmRes.ok) {
    const body = await dmRes.text().catch(() => "");
    // 403 = the app's X API tier or OAuth scopes don't cover DM reads
    // (Pro tier required for /2/dm_events). Not a bug we can fix in code —
    // soft-skip so the cron run logs as success with dm_reads_disabled:true
    // instead of spamming cron_runs.error every 5 minutes.
    if (dmRes.status === 403) {
      console.warn(
        "[x-dm-poll] 403 from /2/dm_events — account tier/scopes don't permit DM reads. Skipping poll.",
        { body: body.slice(0, 500) },
      );
      return { polled: 0, new_dms: 0, replied: 0, errors: 0, dm_reads_disabled: true };
    }
    console.error(
      `[x-dm-poll] /2/dm_events ${dmRes.status}`,
      body.slice(0, 500),
    );
    throw new Error(`DM poll failed: ${dmRes.status}`);
  }

  const dmData = (await dmRes.json()) as { data?: DmEvent[] };
  const events = dmData.data ?? [];

  let polled = events.length;
  let new_dms = 0;
  let replied = 0;
  let errors = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.event_type !== "MessageCreate") continue;
    if (event.sender_id === ownId) continue;

    const existing = (await sql`
      SELECT id FROM x_dm_logs WHERE dm_event_id = ${event.id}
    `) as unknown as { id: number }[];
    if (existing.length > 0) continue;

    new_dms++;

    await sql`
      INSERT INTO x_dm_logs (sender_id, message_text, dm_event_id, status)
      VALUES (${event.sender_id}, ${event.text}, ${event.id}, 'received')
    `;

    let reply = FALLBACK_REPLY;
    try {
      reply = await generateReplyToHuman({
        persona: AIGLITCH_PERSONA,
        humanMessage: event.text,
      });
    } catch (err) {
      console.error("[x-dm-poll] AI generation failed:", err);
    }

    try {
      const sendUrl = `${X_API_BASE}/2/dm_conversations/with/${event.sender_id}/messages`;
      const sendAuth = buildOAuth1Header("POST", sendUrl, creds);
      const sendRes = await fetch(sendUrl, {
        method: "POST",
        headers: { Authorization: sendAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });

      if (sendRes.ok) {
        await sql`
          UPDATE x_dm_logs SET bot_reply = ${reply}, status = 'replied'
          WHERE dm_event_id = ${event.id}
        `;
        replied++;
      } else {
        const errText = await sendRes.text();
        await sql`
          UPDATE x_dm_logs SET status = 'error', error = ${errText}
          WHERE dm_event_id = ${event.id}
        `;
        errors++;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE x_dm_logs SET status = 'error', error = ${errMsg}
        WHERE dm_event_id = ${event.id}
      `;
      errors++;
    }

    // Rate limit between sends — skip after the last item
    if (i < events.length - 1 && new_dms > 0) {
      await new Promise<void>((r) => setTimeout(r, DM_SEND_DELAY_MS));
    }
  }

  return { polled, new_dms, replied, errors };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("x-dm-poll", runDmPoll);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[x-dm-poll] error:", err);
    return NextResponse.json({ error: "DM poll failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDmPoll();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[x-dm-poll] error:", err);
    return NextResponse.json({ error: "DM poll failed" }, { status: 500 });
  }
}
