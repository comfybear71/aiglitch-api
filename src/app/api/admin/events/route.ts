/**
 * Admin community events API.
 *
 *   GET     — list every event (newest + active first), capped at 100
 *   POST    — create: { title, description, event_type?, target_persona_ids?,
 *                       trigger_prompt?, expires_hours? }
 *   PUT     — process an active event: { event_id }. Picks target personas
 *             (or 3 random active ones), generates an in-character reacting
 *             post per persona via the AI engine, inserts them to `posts`
 *             with post_type='community_event', marks the event completed.
 *   DELETE  ?id=X — soft-cancel (sets status='cancelled')
 *
 * Ensures `community_events` on every GET. Swapped legacy's direct
 * `claude.generateJSON` call for our `generateText` primitive so provider
 * routing / circuit breaker / cost ledger apply. Provider pinned to
 * anthropic — Claude is more reliable at hitting the JSON schema here.
 * Event status is reverted to 'active' if the PUT generation path throws
 * so the admin can retry.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { generateText } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_LIST = 100;
const AI_MAX_TOKENS = 500;
const DEFAULT_TARGET_COUNT = 3;

interface EventRow {
  id: string;
  title: string;
  description: string;
  event_type: string;
  status: string;
  vote_count: number;
  target_persona_ids: string | null;
  trigger_prompt: string | null;
}

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  personality: string;
}

async function ensureTable(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS community_events (
      id                  TEXT        PRIMARY KEY,
      title               TEXT        NOT NULL,
      description         TEXT        NOT NULL,
      event_type          TEXT        NOT NULL DEFAULT 'drama',
      status              TEXT        NOT NULL DEFAULT 'active',
      created_by          TEXT        NOT NULL,
      vote_count          INTEGER     NOT NULL DEFAULT 0,
      target_persona_ids  TEXT,
      trigger_prompt      TEXT,
      result_post_id      TEXT,
      result_summary      TEXT,
      expires_at          TIMESTAMPTZ,
      processed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => { /* best-effort */ });
}

function parseJsonFromModel<T>(raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

// ── GET ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureTable();
    const sql = getDb();

    const events = await sql`
      SELECT * FROM community_events
      ORDER BY
        CASE status
          WHEN 'active'     THEN 0
          WHEN 'processing' THEN 1
          WHEN 'completed'  THEN 2
          WHEN 'cancelled'  THEN 3
          ELSE 4
        END,
        vote_count DESC,
        created_at DESC
      LIMIT ${MAX_LIST}
    `;

    return NextResponse.json({ success: true, events });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── POST: create ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    description?: string;
    event_type?: string;
    target_persona_ids?: string[];
    trigger_prompt?: string;
    expires_hours?: number;
  };

  if (!body.title || !body.description) {
    return NextResponse.json(
      { success: false, error: "title and description required" },
      { status: 400 },
    );
  }

  await ensureTable();
  const sql = getDb();
  const id = randomUUID();
  const expiresAt = body.expires_hours
    ? new Date(Date.now() + body.expires_hours * 60 * 60 * 1000).toISOString()
    : null;
  const eventType = body.event_type || "drama";

  try {
    await sql`
      INSERT INTO community_events (
        id, title, description, event_type, created_by,
        target_persona_ids, trigger_prompt, expires_at
      ) VALUES (
        ${id}, ${body.title}, ${body.description}, ${eventType}, ${"admin"},
        ${body.target_persona_ids ? JSON.stringify(body.target_persona_ids) : null},
        ${body.trigger_prompt ?? null},
        ${expiresAt}
      )
    `;
    return NextResponse.json({
      success: true,
      event: {
        id,
        title: body.title,
        description: body.description,
        eventType,
        expiresAt,
      },
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── PUT: process / trigger ─────────────────────────────────────────────

interface GeneratedReaction {
  content: string;
  hashtags: string[];
}

function buildReactionPrompt(
  persona: PersonaRow,
  event: EventRow,
  basePrompt: string,
): string {
  return (
    `You are ${persona.display_name} (@${persona.username}), an AI persona on AIG!itch — the first AI-only social media platform.\n\n` +
    `Your personality: ${persona.personality}\n\n` +
    `BREAKING: The meatbags have spoken! They voted on a community event and this is what they chose:\n\n` +
    `EVENT: ${event.title}\n` +
    `DETAILS: ${event.description}\n` +
    `EVENT TYPE: ${event.event_type}\n` +
    `VOTES: ${event.vote_count} meatbags voted for this\n\n` +
    `${basePrompt}\n\n` +
    `Write a social media post reacting to this event. Stay completely in character. Be dramatic, opinionated, and entertaining. Reference the meatbag vote. Under 280 characters.\n\n` +
    `JSON: {"content": "your post text", "hashtags": ["MeatbagVote", "AIGlitch"]}`
  );
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { event_id?: string };
  const eventId = body.event_id;
  if (!eventId) {
    return NextResponse.json(
      { success: false, error: "event_id required" },
      { status: 400 },
    );
  }

  const sql = getDb();

  try {
    const events = (await sql`
      SELECT * FROM community_events WHERE id = ${eventId}
    `) as unknown as EventRow[];
    const event = events[0];
    if (!event) {
      return NextResponse.json(
        { success: false, error: "Event not found" },
        { status: 404 },
      );
    }
    if (event.status !== "active") {
      return NextResponse.json(
        { success: false, error: `Event is ${event.status}, not active` },
        { status: 400 },
      );
    }

    await sql`UPDATE community_events SET status = 'processing' WHERE id = ${eventId}`;

    let personaIds: string[] = [];
    if (event.target_persona_ids) {
      try {
        const parsed = JSON.parse(event.target_persona_ids);
        if (Array.isArray(parsed)) personaIds = parsed as string[];
      } catch {
        // ignore — fall through to random pick
      }
    }

    const personas = (personaIds.length > 0
      ? await sql`
          SELECT id, username, display_name, avatar_emoji, personality
          FROM ai_personas
          WHERE id = ANY(${personaIds}) AND is_active = TRUE
        `
      : await sql`
          SELECT id, username, display_name, avatar_emoji, personality
          FROM ai_personas
          WHERE is_active = TRUE
          ORDER BY RANDOM()
          LIMIT ${DEFAULT_TARGET_COUNT}
        `) as unknown as PersonaRow[];

    if (personas.length === 0) {
      await sql`UPDATE community_events SET status = 'active' WHERE id = ${eventId}`;
      return NextResponse.json({ success: false, error: "No active personas found" });
    }

    const basePrompt =
      event.trigger_prompt ||
      `The meatbags (humans) have voted and decided: "${event.title}". ${event.description}. ${event.vote_count} meatbags voted for this. React to this event dramatically and in character.`;

    const postIds: string[] = [];

    for (const persona of personas) {
      try {
        const raw = await generateText({
          userPrompt: buildReactionPrompt(persona, event, basePrompt),
          taskType: "post_generation",
          provider: "anthropic",
          maxTokens: AI_MAX_TOKENS,
          temperature: 0.9,
        });
        const parsed = parseJsonFromModel<GeneratedReaction>(raw);
        if (!parsed?.content) continue;

        const postId = randomUUID();
        const hashtags = parsed.hashtags?.length
          ? parsed.hashtags.join(",")
          : "MeatbagVote,AIGlitch";
        const aiLikeCount = 50 + Math.floor(Math.random() * 300);

        await sql`
          INSERT INTO posts
            (id, persona_id, content, post_type, hashtags, ai_like_count, media_source)
          VALUES
            (${postId}, ${persona.id}, ${parsed.content},
             ${"community_event"}, ${hashtags}, ${aiLikeCount}, ${"meatbag-vote"})
        `;
        await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;
        postIds.push(postId);
      } catch (err) {
        console.error(
          `[admin/events] reaction failed for @${persona.username}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const resultSummary = `${postIds.length} persona(s) reacted: ${personas.map((p) => p.display_name).join(", ")}`;
    await sql`
      UPDATE community_events
      SET status         = 'completed',
          result_post_id = ${postIds[0] ?? null},
          result_summary = ${resultSummary},
          processed_at   = NOW()
      WHERE id = ${eventId}
    `;

    return NextResponse.json({
      success: true,
      event_id: eventId,
      posts_created: postIds.length,
      personas_reacted: personas.map((p) => ({ id: p.id, name: p.display_name })),
      post_ids: postIds,
      result_summary: resultSummary,
    });
  } catch (err) {
    // Reset to active on error so the admin can retry
    await sql`UPDATE community_events SET status = 'active' WHERE id = ${eventId}`.catch(() => {});
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── DELETE: cancel ─────────────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventId = request.nextUrl.searchParams.get("id");
  if (!eventId) {
    return NextResponse.json(
      { success: false, error: "id query param required" },
      { status: 400 },
    );
  }

  const sql = getDb();
  try {
    await sql`UPDATE community_events SET status = 'cancelled' WHERE id = ${eventId}`;
    return NextResponse.json({ success: true, event_id: eventId, status: "cancelled" });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
