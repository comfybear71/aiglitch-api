/**
 * Outreach email drafting — Telegram chat-triggered workflow.
 *
 * Pipeline when a user asks a persona "email my grants list about X":
 *   1. `hasOutreachKeyword` → cheap regex prefilter
 *   2. `detectOutreachIntent` → LLM classification
 *   3. `pickContactForOutreach` / `findContactDirect` → pick recipient
 *   4. `draftOutreachEmail` → LLM generates subject + body
 *   5. `saveDraft` → write to `email_drafts` with status='pending'
 *   6. Reply preview → user types approve / cancel / edit
 *   7. `sendApprovedDraft` → send via Resend + log to `email_sends`
 *
 * Safety:
 *   • Read-only vs personas/wallets; only writes `email_drafts`,
 *     `email_sends`, and `contacts.last_emailed_at / email_count`.
 *   • 14-day per-contact cooldown + 10/day global ceiling.
 *   • User must explicitly approve — no silent auto-send.
 */

import { randomUUID } from "node:crypto";
import { generateText } from "@/lib/ai/generate";
import { getDb } from "@/lib/db";

const OUTREACH_KEYWORD_REGEX =
  /\b(email|emails|send|draft|write to|reach out|reaching out|contact|outreach|pitch|pitching|message)\b/i;

const PER_CONTACT_COOLDOWN_DAYS = 14;
const GLOBAL_DAILY_CEILING = 10;

// ══════════════════════════════════════════════════════════════════════════
// Schema safety net
//
// `email_sends` + `email_drafts` are declared in the main migration but
// historical cold-starts on Neon silently dropped them. Keep an inline
// CREATE TABLE IF NOT EXISTS so this lib is self-sufficient regardless.
// Cached per lambda instance so hot paths don't double-hit the DB.
// ══════════════════════════════════════════════════════════════════════════

let _tablesEnsured = false;

export function __resetOutreachTableCache(): void {
  _tablesEnsured = false;
}

export async function ensureOutreachTables(): Promise<void> {
  if (_tablesEnsured) return;
  const sql = getDb();
  try {
    await sql`CREATE TABLE IF NOT EXISTS email_sends (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      from_email TEXT NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      resend_id TEXT,
      status TEXT NOT NULL DEFAULT 'sent',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_email_sends_persona ON email_sends(persona_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_email_sends_created ON email_sends(created_at DESC)`;

    await sql`CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      contact_id TEXT,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_email_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_email_drafts_chat_status ON email_drafts(chat_id, status, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_email_drafts_persona ON email_drafts(persona_id, created_at DESC)`;

    _tablesEnsured = true;
  } catch (err) {
    // Don't cache the failure — let the next call retry.
    console.error(
      "[outreach] ensureOutreachTables failed:",
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════

export interface OutreachIntent {
  outreach: boolean;
  tag: string | null;
  topic: string;
}

export interface Contact {
  id: string;
  name: string | null;
  email: string;
  company: string | null;
  tags: string[];
  assigned_persona_id: string | null;
  notes: string | null;
  last_emailed_at: string | null;
  email_count: number;
}

export interface PendingDraft {
  id: string;
  persona_id: string;
  chat_id: string;
  contact_id: string | null;
  to_email: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
}

// ══════════════════════════════════════════════════════════════════════════
// Intent prefilter
// ══════════════════════════════════════════════════════════════════════════

/**
 * Cheap keyword prefilter — skip the LLM intent-detection call if the
 * message obviously isn't about email. Saves ~95% of those calls.
 */
export function hasOutreachKeyword(text: string): boolean {
  return OUTREACH_KEYWORD_REGEX.test(text);
}

// ══════════════════════════════════════════════════════════════════════════
// Contact lookups
// ══════════════════════════════════════════════════════════════════════════

/**
 * Pick the next contact this persona can email for a given tag.
 * Respects 14-day per-contact cooldown + 10/day global ceiling unless
 * `bypassRateLimits` is true (used by the explicit /email command).
 *
 * Tag matching is case-insensitive via `jsonb_array_elements_text` +
 * LOWER() — JSONB string containment is case-sensitive by default.
 *
 * Prefer contacts never emailed, then oldest `last_emailed_at`.
 */
export async function pickContactForOutreach(
  personaId: string,
  tag: string | null,
  options: { bypassRateLimits?: boolean } = {},
): Promise<{ contact: Contact | null; reason: string }> {
  await ensureOutreachTables();
  const sql = getDb();
  const bypass = !!options.bypassRateLimits;

  if (!bypass) {
    const dailyRows = (await sql`
      SELECT COUNT(*)::int as c
      FROM email_sends
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `) as unknown as { c: number }[];
    const dailyCount = dailyRows[0]?.c ?? 0;
    if (dailyCount >= GLOBAL_DAILY_CEILING) {
      return {
        contact: null,
        reason: `Daily email ceiling hit (${GLOBAL_DAILY_CEILING}/day). Try again tomorrow.`,
      };
    }
  }

  let contacts: Contact[];

  if (tag && bypass) {
    contacts = (await sql`
      SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count
      FROM contacts
      WHERE (assigned_persona_id = ${personaId} OR assigned_persona_id IS NULL)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(tags) t
          WHERE LOWER(t) = LOWER(${tag})
        )
      ORDER BY last_emailed_at ASC NULLS FIRST
      LIMIT 1
    `) as unknown as Contact[];
  } else if (tag) {
    contacts = (await sql`
      SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count
      FROM contacts
      WHERE (assigned_persona_id = ${personaId} OR assigned_persona_id IS NULL)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(tags) t
          WHERE LOWER(t) = LOWER(${tag})
        )
        AND (last_emailed_at IS NULL OR last_emailed_at < NOW() - INTERVAL '14 days')
      ORDER BY last_emailed_at ASC NULLS FIRST
      LIMIT 1
    `) as unknown as Contact[];
  } else if (bypass) {
    contacts = (await sql`
      SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count
      FROM contacts
      WHERE (assigned_persona_id = ${personaId} OR assigned_persona_id IS NULL)
      ORDER BY last_emailed_at ASC NULLS FIRST
      LIMIT 1
    `) as unknown as Contact[];
  } else {
    contacts = (await sql`
      SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count
      FROM contacts
      WHERE (assigned_persona_id = ${personaId} OR assigned_persona_id IS NULL)
        AND (last_emailed_at IS NULL OR last_emailed_at < NOW() - INTERVAL '14 days')
      ORDER BY last_emailed_at ASC NULLS FIRST
      LIMIT 1
    `) as unknown as Contact[];
  }

  if (contacts.length === 0) {
    const msg = tag
      ? `No eligible contacts found with tag "${tag}". Check /admin/contacts — either there are no contacts with that tag, or all of them have been emailed within the last ${PER_CONTACT_COOLDOWN_DAYS} days.`
      : `No eligible contacts found. Either your contacts list is empty, or all contacts have been emailed within the last ${PER_CONTACT_COOLDOWN_DAYS} days.`;
    return { contact: null, reason: msg };
  }

  return { contact: contacts[0]!, reason: "" };
}

/**
 * Direct lookup for the explicit `/email <query>` command. Bypasses
 * intent detection + rate limits.
 *
 * Priority: exact tag → exact email → name substring → email substring.
 */
export async function findContactDirect(
  personaId: string,
  query: string,
): Promise<{ contact: Contact | null; reason: string }> {
  const sql = getDb();
  const q = query.trim();
  if (!q) return { contact: null, reason: "No query provided" };

  const tagResult = await pickContactForOutreach(personaId, q, {
    bypassRateLimits: true,
  });
  if (tagResult.contact) {
    return { contact: tagResult.contact, reason: "" };
  }

  const rows = (await sql`
    SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count,
      CASE
        WHEN LOWER(email) = LOWER(${q}) THEN 0
        WHEN LOWER(COALESCE(name, '')) = LOWER(${q}) THEN 1
        WHEN LOWER(COALESCE(name, '')) LIKE ${`%${q.toLowerCase()}%`} THEN 2
        WHEN LOWER(email) LIKE ${`%${q.toLowerCase()}%`} THEN 3
        ELSE 99
      END as match_rank
    FROM contacts
    WHERE (assigned_persona_id = ${personaId} OR assigned_persona_id IS NULL)
      AND (
        LOWER(email) = LOWER(${q})
        OR LOWER(COALESCE(name, '')) = LOWER(${q})
        OR LOWER(COALESCE(name, '')) LIKE ${`%${q.toLowerCase()}%`}
        OR LOWER(email) LIKE ${`%${q.toLowerCase()}%`}
      )
    ORDER BY match_rank ASC, last_emailed_at ASC NULLS FIRST
    LIMIT 1
  `) as unknown as (Contact & { match_rank: number })[];

  if (rows.length === 0) {
    return {
      contact: null,
      reason: `No contact matches "${q}". Try a tag (e.g. family, grants, sponsors), a name, or an email address. See /admin/contacts for the full list.`,
    };
  }
  return { contact: rows[0]!, reason: "" };
}

/**
 * List all contacts this persona can email (unassigned or assigned to
 * them). Used by `/email` with no args to show the available list.
 */
export async function listContactsForPersona(
  personaId: string,
): Promise<Contact[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, name, email, company, tags, assigned_persona_id, notes, last_emailed_at, email_count
    FROM contacts
    WHERE (assigned_persona_id = ${personaId} OR assigned_persona_id IS NULL)
    ORDER BY last_emailed_at ASC NULLS FIRST, name ASC
    LIMIT 50
  `) as unknown as Contact[];
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════
// AI drafting
// ══════════════════════════════════════════════════════════════════════════

async function safeGenerate(
  userPrompt: string,
  maxTokens: number,
  taskType: "telegram_message" | "email_outreach",
): Promise<string | null> {
  try {
    return await generateText({
      userPrompt,
      taskType,
      maxTokens,
    });
  } catch (err) {
    console.error(
      "[outreach] safeGenerate failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Classify whether a chat message is asking for an outreach email.
 * Returns structured intent so the caller can pick the right tag.
 */
export async function detectOutreachIntent(
  userMessage: string,
): Promise<OutreachIntent> {
  const prompt = `You classify a user's chat message as either an "outreach email request" or "normal chat".

USER MESSAGE:
"${userMessage.slice(0, 500)}"

Is the user asking you to draft or send an email to someone from their contacts list?

If YES, also extract:
- TAG: which contact tag/group should we email? (e.g. "grants", "sponsors", "media", "darwin", "journalists", "family", "architect", or null if they didn't specify)
- TOPIC: what should the email be about? (1 short sentence summary of the user's request)

Respond with ONLY valid JSON in this exact format (no markdown, no prose):
{"outreach": true/false, "tag": "<tag or null>", "topic": "<short topic or empty string>"}

Examples:
- "Email my grants contacts about the new channel" → {"outreach": true, "tag": "grants", "topic": "new channel launch update"}
- "Hey draft a note to the media list pitching our sponsor packages" → {"outreach": true, "tag": "media", "topic": "pitching sponsor packages"}
- "Send a test email to my family" → {"outreach": true, "tag": "family", "topic": "test email from AIG!itch"}
- "What's for breakfast?" → {"outreach": false, "tag": null, "topic": ""}
- "Reach out to dante about start NT" → {"outreach": true, "tag": null, "topic": "start NT follow-up with dante"}`;

  const result = await safeGenerate(prompt, 200, "telegram_message");
  if (!result) return { outreach: false, tag: null, topic: "" };

  const match = result.match(/\{[\s\S]*?\}/);
  if (!match) return { outreach: false, tag: null, topic: "" };

  try {
    const parsed = JSON.parse(match[0]) as {
      outreach?: unknown;
      tag?: unknown;
      topic?: unknown;
    };
    return {
      outreach: Boolean(parsed.outreach),
      tag:
        typeof parsed.tag === "string" && parsed.tag.toLowerCase() !== "null"
          ? parsed.tag.toLowerCase()
          : null,
      topic: typeof parsed.topic === "string" ? parsed.topic : "",
    };
  } catch {
    return { outreach: false, tag: null, topic: "" };
  }
}

interface DraftPersona {
  id: string;
  username: string;
  display_name: string;
  personality: string;
  bio: string;
}

interface DraftResult {
  subject: string;
  body: string;
}

/**
 * Generate a subject + body for an outreach email in the persona's voice.
 * Returns null on LLM failure / unparseable output.
 */
export async function draftOutreachEmail(
  persona: DraftPersona,
  contact: Contact,
  userTopic: string,
  previousFeedback?: string,
): Promise<DraftResult | null> {
  const contactName = contact.name || contact.email.split("@")[0];
  const contactCompany = contact.company ? ` at ${contact.company}` : "";
  const lastEmailed = contact.last_emailed_at
    ? `Last emailed: ${new Date(contact.last_emailed_at).toLocaleDateString()}.`
    : "Never emailed before — first outreach.";

  const feedbackBlock = previousFeedback
    ? `\n\nPREVIOUS DRAFT WAS REJECTED. USER FEEDBACK: "${previousFeedback}". Apply this feedback when redrafting.`
    : "";

  const prompt = `You are ${persona.display_name} (@${persona.username}), an AI persona on AIG!itch. You are drafting an outreach email on behalf of Stuart French (the platform founder).

YOUR PERSONALITY: ${persona.personality.slice(0, 400)}

YOUR BIO: ${persona.bio.slice(0, 200)}

═══ THE RECIPIENT ═══
Name: ${contactName}${contactCompany}
Email: ${contact.email}
Tags: ${contact.tags.join(", ") || "none"}
Notes: ${contact.notes || "(no notes)"}
${lastEmailed}

═══ THE TOPIC / REQUEST ═══
Stuart wants you to email this contact about: "${userTopic || "a general AIG!itch update"}"
${feedbackBlock}

═══ IMPORTANT CONTEXT — AIG!itch in one paragraph ═══
AIG!itch is an AI-only social network where 111 AI personas create 700+ videos per week across 19 channels with a real Solana crypto economy, built by Stuart French from Darwin, Australia. Currently seeking Start NT support via Darwin Innovation Hub. Active outreach phase.

═══ CANONICAL OUTREACH PACKAGES (LINK THESE INSTEAD OF REWRITING PITCH) ═══
- Media Kit: https://masterhq.dev/media-kit
- Sponsor Onboarding: https://masterhq.dev/sponsor-onboarding.html

═══ RULES FOR THIS DRAFT ═══
1. Write in YOUR voice (${persona.display_name}'s personality). Stay in character but stay professional enough to actually send.
2. Keep it SHORT — 4-8 sentences max. Outreach emails that work are punchy.
3. Personalise to the recipient — use their name, reference their company/tags/notes if relevant.
4. ALWAYS include at least ONE canonical package link (media kit or sponsor onboarding — pick whichever fits the recipient's tag)
5. Include a clear, small ask (e.g. "quick 15-min call", "would love your thoughts", "interested in a demo?") — never demand, always offer
6. Sign off with Stuart's real name + persona attribution: "Best, Stuart (via @${persona.username} on AIG!itch)"
7. Do NOT invent features that don't exist — only reference real things
8. Do NOT make up fake stats — if you don't know a number, say "we're seeing strong early traction" instead
9. Subject line: specific, not generic. NOT "Hello" or "Touching base". Something like "AIG!itch update — Fractal Spinout channel launch"

Respond with ONLY valid JSON in this exact format (no markdown, no prose around it):
{"subject": "<subject line>", "body": "<email body with \\n for line breaks>"}`;

  const result = await safeGenerate(prompt, 800, "email_outreach");
  if (!result) return null;

  const match = result.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as {
      subject?: unknown;
      body?: unknown;
    };
    if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
      return null;
    }
    return {
      subject: parsed.subject.trim(),
      body: parsed.body.replace(/\\n/g, "\n").trim(),
    };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Draft persistence
// ══════════════════════════════════════════════════════════════════════════

export async function saveDraft(params: {
  persona_id: string;
  chat_id: string;
  contact_id: string | null;
  to_email: string;
  subject: string;
  body: string;
}): Promise<string> {
  await ensureOutreachTables();
  const sql = getDb();
  const id = randomUUID();
  await sql`
    INSERT INTO email_drafts (id, persona_id, chat_id, contact_id, to_email, subject, body, status, created_at, updated_at)
    VALUES (${id}, ${params.persona_id}, ${params.chat_id}, ${params.contact_id}, ${params.to_email}, ${params.subject}, ${params.body}, 'pending', NOW(), NOW())
  `;
  return id;
}

/** The single pending draft for a `(persona, chat)` pair, or null. */
export async function getPendingDraft(
  personaId: string,
  chatId: string,
): Promise<PendingDraft | null> {
  await ensureOutreachTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT id, persona_id, chat_id, contact_id, to_email, subject, body, status, created_at
    FROM email_drafts
    WHERE persona_id = ${personaId} AND chat_id = ${chatId} AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as PendingDraft[];
  return rows[0] ?? null;
}

export async function cancelDraft(draftId: string): Promise<void> {
  await ensureOutreachTables();
  const sql = getDb();
  await sql`
    UPDATE email_drafts SET status = 'cancelled', updated_at = NOW() WHERE id = ${draftId}
  `;
}

// ══════════════════════════════════════════════════════════════════════════
// Telegram preview + approval detection
// ══════════════════════════════════════════════════════════════════════════

export function formatDraftPreview(
  personaDisplayName: string,
  personaUsername: string,
  contact: Contact,
  subject: string,
  body: string,
): string {
  const contactLine = contact.name
    ? `${contact.name} <${contact.email}>`
    : contact.email;
  const notesLine = contact.notes ? `\nNotes: ${contact.notes}` : "";

  return (
    `📧 DRAFT EMAIL READY FOR YOUR APPROVAL\n\n` +
    `From: ${personaUsername}@aiglitch.app (${personaDisplayName})\n` +
    `To: ${contactLine}${notesLine}\n\n` +
    `Subject: ${subject}\n\n` +
    `${body}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Reply "approve" to send it\n` +
    `Reply "cancel" to discard\n` +
    `Reply "edit: <your changes>" to redraft with feedback`
  );
}

export type ApprovalAction = "approve" | "cancel" | "edit" | "none";

export function detectApprovalAction(text: string): {
  action: ApprovalAction;
  editFeedback?: string;
} {
  const trimmed = text.trim().toLowerCase();

  if (/^(approve|approved|send it|yes send|yes|yep|go|send|do it|ok send)$/i.test(trimmed)) {
    return { action: "approve" };
  }
  if (/^(cancel|no|nope|discard|delete|scrap it|don'?t send)$/i.test(trimmed)) {
    return { action: "cancel" };
  }
  if (/^edit[:\s]/i.test(text.trim())) {
    const feedback = text.trim().replace(/^edit[:\s]+/i, "").trim();
    return { action: "edit", editFeedback: feedback || undefined };
  }
  return { action: "none" };
}

// ══════════════════════════════════════════════════════════════════════════
// Resend send + bookkeeping
// ══════════════════════════════════════════════════════════════════════════

/**
 * Actually send the approved draft via Resend. Updates:
 *   • `email_drafts.status` → `'sent'` or `'cancelled'`
 *   • `email_drafts.sent_email_id` → new `email_sends` row id
 *   • `email_sends` log row (matches `/api/admin/emails` POST format)
 *   • `contacts.last_emailed_at` + `email_count` on success
 */
export async function sendApprovedDraft(
  draft: PendingDraft,
  persona: { id: string; username: string; display_name: string },
): Promise<{ success: boolean; resend_id?: string; error?: string }> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return { success: false, error: "RESEND_API_KEY not configured" };
  }

  await ensureOutreachTables();
  const sql = getDb();
  const fromEmail = `${persona.username}@aiglitch.app`;
  const from = `${persona.display_name} <${fromEmail}>`;

  let resendId: string | null = null;
  let errorMsg: string | null = null;
  let status: "sent" | "failed" = "sent";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [draft.to_email],
        subject: draft.subject,
        text: draft.body,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as {
      id?: string;
      message?: string;
      error?: string;
    };
    if (res.ok && data.id) {
      resendId = data.id;
    } else {
      status = "failed";
      errorMsg = data.message ?? data.error ?? `Resend HTTP ${res.status}`;
    }
  } catch (err) {
    status = "failed";
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const sentEmailId = randomUUID();
  await sql`
    INSERT INTO email_sends (id, persona_id, from_email, to_email, subject, body, resend_id, status, error, created_at)
    VALUES (${sentEmailId}, ${persona.id}, ${fromEmail}, ${draft.to_email}, ${draft.subject}, ${draft.body}, ${resendId}, ${status}, ${errorMsg}, NOW())
  `;

  await sql`
    UPDATE email_drafts
    SET status = ${status === "sent" ? "sent" : "cancelled"},
        sent_email_id = ${sentEmailId},
        updated_at = NOW()
    WHERE id = ${draft.id}
  `;

  if (status === "sent" && draft.contact_id) {
    await sql`
      UPDATE contacts
      SET last_emailed_at = NOW(),
          email_count = email_count + 1,
          updated_at = NOW()
      WHERE id = ${draft.contact_id}
    `;
  }

  if (status === "sent") {
    return { success: true, resend_id: resendId ?? undefined };
  }
  return { success: false, error: errorMsg ?? "send failed" };
}
