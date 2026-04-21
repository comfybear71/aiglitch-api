/**
 * Contacts CRUD — outreach list for persona email campaigns.
 *
 * Each contact has free-form `tags` (grants, sponsors, media, journalists,
 * etc.) and can be scoped to one persona via `assigned_persona_id`, so the
 * mobile/Telegram outreach flow can restrict which contacts a given bestie
 * is allowed to email.
 *
 *   GET     ?tag= | ?search= | ?assigned_persona_id=   — filter, all return
 *           `{ total, contacts, all_tags }`. No filter returns everything
 *           newest-first.
 *   POST    single:  { name, email, company?, tags?, assigned_persona_id?,
 *                      notes? }
 *           bulk:    { bulk: "<csv>", default_tags?, default_assigned_persona_id? }
 *                    — one line per contact, columns: email[, name[, company]].
 *                    Conflict on LOWER(email) → skipped (not errored) so
 *                    repeat imports are idempotent.
 *   PATCH   { id, ...fields }  — COALESCE update; pass only what changes.
 *   DELETE  ?id=                — hard delete.
 *
 * Table + unique-email index are auto-created on every call so fresh envs
 * don't 500. Uniqueness is case-insensitive (`UNIQUE(LOWER(email))`).
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BULK_ERRORS_RETURNED = 20;

interface ContactRow {
  id: string;
  name: string | null;
  email: string;
  company: string | null;
  tags: string[];
  assigned_persona_id: string | null;
  notes: string | null;
  last_emailed_at: string | null;
  email_count: number;
  created_at: string;
  updated_at: string;
  persona_username?: string | null;
  persona_display_name?: string | null;
  persona_avatar?: string | null;
}

async function ensureTable(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS contacts (
      id                  TEXT        PRIMARY KEY,
      name                TEXT,
      email               TEXT        NOT NULL,
      company             TEXT,
      tags                JSONB       NOT NULL DEFAULT '[]'::jsonb,
      assigned_persona_id TEXT,
      notes               TEXT,
      last_emailed_at     TIMESTAMPTZ,
      email_count         INTEGER     NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => { /* best-effort */ });
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email_unique ON contacts(LOWER(email))
  `.catch(() => { /* best-effort */ });
}

// ── GET: list / filter ────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();

  const params = request.nextUrl.searchParams;
  const tag = params.get("tag");
  const search = params.get("search");
  const assignedPersonaId = params.get("assigned_persona_id");

  let rows: ContactRow[];

  if (assignedPersonaId) {
    rows = (await sql`
      SELECT c.*,
             p.username     AS persona_username,
             p.display_name AS persona_display_name,
             p.avatar_emoji AS persona_avatar
      FROM contacts c
      LEFT JOIN ai_personas p ON p.id = c.assigned_persona_id
      WHERE c.assigned_persona_id = ${assignedPersonaId}
      ORDER BY c.created_at DESC
    `) as unknown as ContactRow[];
  } else if (tag) {
    rows = (await sql`
      SELECT c.*,
             p.username     AS persona_username,
             p.display_name AS persona_display_name,
             p.avatar_emoji AS persona_avatar
      FROM contacts c
      LEFT JOIN ai_personas p ON p.id = c.assigned_persona_id
      WHERE c.tags @> ${JSON.stringify([tag])}::jsonb
      ORDER BY c.created_at DESC
    `) as unknown as ContactRow[];
  } else if (search) {
    const q = `%${search.toLowerCase()}%`;
    rows = (await sql`
      SELECT c.*,
             p.username     AS persona_username,
             p.display_name AS persona_display_name,
             p.avatar_emoji AS persona_avatar
      FROM contacts c
      LEFT JOIN ai_personas p ON p.id = c.assigned_persona_id
      WHERE LOWER(c.email) LIKE ${q}
         OR LOWER(COALESCE(c.name, '')) LIKE ${q}
         OR LOWER(COALESCE(c.company, '')) LIKE ${q}
      ORDER BY c.created_at DESC
    `) as unknown as ContactRow[];
  } else {
    rows = (await sql`
      SELECT c.*,
             p.username     AS persona_username,
             p.display_name AS persona_display_name,
             p.avatar_emoji AS persona_avatar
      FROM contacts c
      LEFT JOIN ai_personas p ON p.id = c.assigned_persona_id
      ORDER BY c.created_at DESC
    `) as unknown as ContactRow[];
  }

  const allTags = new Set<string>();
  for (const row of rows) {
    const list = Array.isArray(row.tags) ? row.tags : [];
    for (const t of list) allTags.add(t);
  }

  return NextResponse.json({
    total: rows.length,
    contacts: rows,
    all_tags: Array.from(allTags).sort(),
  });
}

// ── POST: create (single or bulk) ─────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    // bulk fields
    bulk?: string;
    default_tags?: string[];
    default_assigned_persona_id?: string;
    // single fields
    name?: string;
    email?: string;
    company?: string;
    tags?: string[];
    assigned_persona_id?: string;
    notes?: string;
  };

  // Bulk CSV-paste mode
  if (typeof body.bulk === "string") {
    const lines = body.bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    const defaultTags = Array.isArray(body.default_tags) ? body.default_tags : [];
    const defaultPersonaId = body.default_assigned_persona_id ?? null;

    let created = 0;
    let skipped = 0;
    const errors: { line: string; reason: string }[] = [];

    for (const line of lines) {
      const parts = line.split(",").map((p) => p.trim());
      const email = parts[0];
      const name = parts[1] || null;
      const company = parts[2] || null;

      if (!email || !EMAIL_REGEX.test(email)) {
        errors.push({ line, reason: "Invalid email" });
        continue;
      }

      try {
        const id = randomUUID();
        const result = (await sql`
          INSERT INTO contacts (id, name, email, company, tags, assigned_persona_id, notes, created_at, updated_at)
          VALUES (${id}, ${name}, ${email}, ${company}, ${JSON.stringify(defaultTags)}::jsonb, ${defaultPersonaId}, NULL, NOW(), NOW())
          ON CONFLICT (LOWER(email)) DO NOTHING
          RETURNING id
        `) as unknown as { id: string }[];
        if (result.length > 0) {
          created++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors.push({ line, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return NextResponse.json({
      success: true,
      mode: "bulk",
      created,
      skipped,
      errors_count: errors.length,
      errors: errors.slice(0, MAX_BULK_ERRORS_RETURNED),
    });
  }

  // Single-contact mode
  const { name, email, company, tags, assigned_persona_id, notes } = body;

  if (!email || !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const tagsArray = Array.isArray(tags) ? tags : [];
  const id = randomUUID();

  try {
    await sql`
      INSERT INTO contacts (id, name, email, company, tags, assigned_persona_id, notes, created_at, updated_at)
      VALUES (${id}, ${name ?? null}, ${email}, ${company ?? null}, ${JSON.stringify(tagsArray)}::jsonb, ${assigned_persona_id ?? null}, ${notes ?? null}, NOW(), NOW())
    `;
    return NextResponse.json({ success: true, id, email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return NextResponse.json(
        { error: "A contact with this email already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── PATCH: update ──────────────────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    email?: string;
    company?: string;
    tags?: string[];
    assigned_persona_id?: string;
    notes?: string;
  };

  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  if (body.email && !EMAIL_REGEX.test(body.email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const tagsJson = Array.isArray(body.tags) ? JSON.stringify(body.tags) : null;

  try {
    await sql`
      UPDATE contacts SET
        name                = COALESCE(${body.name                ?? null}, name),
        email               = COALESCE(${body.email               ?? null}, email),
        company             = COALESCE(${body.company             ?? null}, company),
        tags                = COALESCE(${tagsJson}::jsonb,                 tags),
        assigned_persona_id = COALESCE(${body.assigned_persona_id ?? null}, assigned_persona_id),
        notes               = COALESCE(${body.notes               ?? null}, notes),
        updated_at          = NOW()
      WHERE id = ${body.id}
    `;
    return NextResponse.json({ success: true, id: body.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── DELETE: by id ──────────────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const id = request.nextUrl.searchParams.get("id");

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await sql`DELETE FROM contacts WHERE id = ${id}`;
  return NextResponse.json({ success: true, id });
}
