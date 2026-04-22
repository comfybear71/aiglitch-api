/**
 * Outreach email drafting — Telegram chat-triggered workflow.
 *
 * Pipeline when a user asks a persona "email my grants list about X":
 *   1. `hasOutreachKeyword` → cheap regex prefilter
 *   2. `detectOutreachIntent` → LLM classification (in parcel 3b)
 *   3. `pickContactForOutreach` / `findContactDirect` → pick recipient
 *   4. `draftOutreachEmail` → LLM generates subject + body (parcel 3b)
 *   5. `saveDraft` → write to `email_drafts` with status='pending'
 *   6. Reply preview → user types approve / cancel / edit
 *   7. `sendApprovedDraft` → send via Resend + log to `email_sends`
 *
 * Safety:
 *   • Read-only vs personas/wallets; only writes `email_drafts`,
 *     `email_sends`, and `contacts.last_emailed_at / email_count`.
 *   • 14-day per-contact cooldown + 10/day global ceiling.
 *   • User must explicitly approve — no silent auto-send.
 *
 * This parcel (3a) covers types + contact lookups. AI drafting,
 * approval detection, and Resend sending are in parcel 3b.
 */

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
