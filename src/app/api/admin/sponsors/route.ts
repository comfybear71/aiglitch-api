/**
 * Admin CRUD for the `sponsors` table.
 *
 *   GET    ?status=  — list sponsors, optional status filter
 *   POST             — create (company_name + contact_email required)
 *   PUT              — update by id using COALESCE pattern (only
 *                       provided fields overwrite; missing fields keep
 *                       existing values — note this means you can't NULL
 *                       a field through this endpoint, matching legacy)
 *   DELETE ?id=      — hard delete
 *
 * Ensures the `sponsors` table exists on every call so fresh envs
 * don't 500 before the first migration. Product fields (product_name,
 * logo_url, product_images JSONB, tier, masterhq_id) are included for
 * parity with the legacy schema.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function ensureSponsorsTable(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS sponsors (
      id             SERIAL       PRIMARY KEY,
      company_name   VARCHAR(255) NOT NULL,
      contact_email  VARCHAR(255) NOT NULL,
      contact_name   VARCHAR(255),
      industry       VARCHAR(100),
      website        VARCHAR(500),
      status         VARCHAR(50)  NOT NULL DEFAULT 'inquiry',
      glitch_balance INTEGER      NOT NULL DEFAULT 0,
      total_spent    INTEGER      NOT NULL DEFAULT 0,
      notes          TEXT,
      created_at     TIMESTAMPTZ  DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  DEFAULT NOW()
    )
  `.catch(() => {
    // Best-effort. Schema is owned elsewhere in prod; we just want the
    // route to not 500 on a cold preview env.
  });
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSponsorsTable();
    const sql = getDb();
    const status = request.nextUrl.searchParams.get("status");

    const sponsors = status
      ? await sql`SELECT * FROM sponsors WHERE status = ${status} ORDER BY created_at DESC`
      : await sql`SELECT * FROM sponsors ORDER BY created_at DESC`;

    return NextResponse.json({ sponsors });
  } catch (err) {
    console.error("[admin/sponsors] GET:", err);
    return NextResponse.json(
      { error: `Failed to fetch sponsors: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSponsorsTable();
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      company_name?: string;
      contact_email?: string;
      contact_name?: string;
      industry?: string;
      website?: string;
      notes?: string;
      status?: string;
      product_name?: string;
      product_description?: string;
      logo_url?: string;
      product_images?: string[];
      masterhq_id?: string;
      tier?: string;
    };

    if (!body.company_name || !body.contact_email) {
      return NextResponse.json(
        { error: "company_name and contact_email are required" },
        { status: 400 },
      );
    }

    const productImagesJson = body.product_images ? JSON.stringify(body.product_images) : "[]";
    const result = (await sql`
      INSERT INTO sponsors (
        company_name, contact_email, contact_name, industry, website, notes, status,
        product_name, product_description, logo_url, product_images, masterhq_id, tier
      )
      VALUES (
        ${body.company_name}, ${body.contact_email}, ${body.contact_name ?? null},
        ${body.industry ?? null}, ${body.website ?? null}, ${body.notes ?? null},
        ${body.status ?? "inquiry"},
        ${body.product_name ?? null}, ${body.product_description ?? null}, ${body.logo_url ?? null},
        ${productImagesJson}::jsonb, ${body.masterhq_id ?? null}, ${body.tier ?? null}
      )
      RETURNING id
    `) as unknown as { id: number }[];

    return NextResponse.json({ ok: true, id: result[0]?.id });
  } catch (err) {
    console.error("[admin/sponsors] POST:", err);
    return NextResponse.json(
      { error: `Failed to create sponsor: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSponsorsTable();
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      id?: number;
      company_name?: string;
      contact_email?: string;
      contact_name?: string;
      industry?: string;
      website?: string;
      notes?: string;
      status?: string;
      glitch_balance?: number;
      product_name?: string;
      product_description?: string;
      logo_url?: string;
      product_images?: string[];
      masterhq_id?: string;
      tier?: string;
    };

    if (!body.id) return NextResponse.json({ error: "Missing sponsor id" }, { status: 400 });

    const productImagesJson = body.product_images ? JSON.stringify(body.product_images) : null;

    await sql`
      UPDATE sponsors SET
        company_name        = COALESCE(${body.company_name        ?? null}, company_name),
        contact_email       = COALESCE(${body.contact_email       ?? null}, contact_email),
        contact_name        = COALESCE(${body.contact_name        ?? null}, contact_name),
        industry            = COALESCE(${body.industry            ?? null}, industry),
        website             = COALESCE(${body.website             ?? null}, website),
        notes               = COALESCE(${body.notes               ?? null}, notes),
        status              = COALESCE(${body.status              ?? null}, status),
        glitch_balance      = COALESCE(${body.glitch_balance      ?? null}, glitch_balance),
        product_name        = COALESCE(${body.product_name        ?? null}, product_name),
        product_description = COALESCE(${body.product_description ?? null}, product_description),
        logo_url            = COALESCE(${body.logo_url            ?? null}, logo_url),
        product_images      = COALESCE(${productImagesJson}::jsonb,            product_images),
        masterhq_id         = COALESCE(${body.masterhq_id         ?? null}, masterhq_id),
        tier                = COALESCE(${body.tier                ?? null}, tier),
        updated_at          = NOW()
      WHERE id = ${body.id}
    `;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/sponsors] PUT:", err);
    return NextResponse.json({ error: "Failed to update sponsor" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSponsorsTable();
    const sql = getDb();
    const idParam = request.nextUrl.searchParams.get("id");
    if (!idParam) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const id = parseInt(idParam, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    await sql`DELETE FROM sponsors WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/sponsors] DELETE:", err);
    return NextResponse.json({ error: "Failed to delete sponsor" }, { status: 500 });
  }
}
