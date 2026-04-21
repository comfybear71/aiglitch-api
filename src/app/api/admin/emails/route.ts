/**
 * Persona email send endpoint — admin-triggered only.
 *
 * Every persona has an implicit address: `<username>@aiglitch.app`.
 * The domain is verified on Resend so any subname can send; inbound
 * mail is handled separately by ImprovMX forwarding to the human
 * admin. We only do outbound here.
 *
 *   GET    ?persona_id=X      — per-persona history, newest first
 *   GET    (no params)         — global log across all personas
 *   GET    ?limit=N            — cap results (default 100, max 500)
 *
 *   POST   { persona_id, to, subject, body }
 *     - requires admin auth
 *     - persona must be is_active
 *     - to must look like an email
 *     - rate-limited 3/hr per persona
 *     - every attempt (success or fail) logs to email_sends for audit
 *     - 502 on Resend failure (row still written)
 *     - 429 when rate limit hits
 *
 * Never leaks RESEND_API_KEY. Table auto-created on every call.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_LIMIT_PER_HOUR = 3;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_TIMEOUT_MS = 15_000;

async function ensureTable(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS email_sends (
      id         TEXT         PRIMARY KEY,
      persona_id TEXT         NOT NULL,
      from_email TEXT         NOT NULL,
      to_email   TEXT         NOT NULL,
      subject    TEXT         NOT NULL,
      body       TEXT         NOT NULL,
      resend_id  TEXT,
      status     TEXT         NOT NULL DEFAULT 'sent',
      error      TEXT,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `.catch(() => { /* best-effort */ });
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

// ── GET: audit log ────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const personaId = request.nextUrl.searchParams.get("persona_id");
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));

  const emails = personaId
    ? await sql`
        SELECT e.id, e.persona_id, e.from_email, e.to_email, e.subject, e.body,
               e.resend_id, e.status, e.error, e.created_at,
               p.username, p.display_name, p.avatar_emoji
        FROM email_sends e
        JOIN ai_personas p ON p.id = e.persona_id
        WHERE e.persona_id = ${personaId}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT e.id, e.persona_id, e.from_email, e.to_email, e.subject, e.body,
               e.resend_id, e.status, e.error, e.created_at,
               p.username, p.display_name, p.avatar_emoji
        FROM email_sends e
        JOIN ai_personas p ON p.id = e.persona_id
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `;

  return NextResponse.json({ total: emails.length, emails });
}

// ── POST: send one email ──────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
    to?: string;
    subject?: string;
    body?: string;
  };

  if (!body.persona_id) return NextResponse.json({ error: "persona_id required" }, { status: 400 });
  if (!body.to)         return NextResponse.json({ error: "to required" }, { status: 400 });
  if (!body.subject)    return NextResponse.json({ error: "subject required" }, { status: 400 });
  if (!body.body)       return NextResponse.json({ error: "body required" }, { status: 400 });

  if (!EMAIL_REGEX.test(body.to)) {
    return NextResponse.json({ error: "Invalid recipient email address" }, { status: 400 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  const personaRows = (await sql`
    SELECT id, username, display_name
    FROM ai_personas
    WHERE id = ${body.persona_id} AND is_active = TRUE
    LIMIT 1
  `) as unknown as { id: string; username: string; display_name: string }[];
  const persona = personaRows[0];
  if (!persona) {
    return NextResponse.json({ error: "Persona not found or inactive" }, { status: 404 });
  }

  const rateRows = (await sql`
    SELECT COUNT(*)::int AS c
    FROM email_sends
    WHERE persona_id = ${body.persona_id}
      AND created_at > NOW() - INTERVAL '1 hour'
  `) as unknown as { c: number }[];
  const sentInLastHour = rateRows[0]?.c ?? 0;

  if (sentInLastHour >= RATE_LIMIT_PER_HOUR) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded: ${persona.username} has already sent ${RATE_LIMIT_PER_HOUR} emails in the past hour. Try again later.`,
      },
      { status: 429 },
    );
  }

  const fromEmail = `${persona.username}@aiglitch.app`;
  const from = `${persona.display_name} <${fromEmail}>`;

  let resendId: string | null = null;
  let status: "sent" | "failed" = "sent";
  let errorMsg: string | null = null;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [body.to],
        subject: body.subject,
        text: body.body,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      error?: string;
    };
    if (res.ok && data.id) {
      resendId = data.id;
    } else {
      status = "failed";
      errorMsg = data.message || data.error || `Resend HTTP ${res.status}`;
    }
  } catch (err) {
    status = "failed";
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const id = randomUUID();
  await sql`
    INSERT INTO email_sends (id, persona_id, from_email, to_email, subject, body, resend_id, status, error, created_at)
    VALUES (${id}, ${body.persona_id}, ${fromEmail}, ${body.to}, ${body.subject}, ${body.body}, ${resendId}, ${status}, ${errorMsg}, NOW())
  `;

  if (status === "failed") {
    return NextResponse.json(
      { success: false, id, status: "failed", error: errorMsg },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    id,
    status: "sent",
    from: fromEmail,
    to: body.to,
    subject: body.subject,
    resend_id: resendId,
  });
}
