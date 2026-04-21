/**
 * Admin Merch Studio — library of merch designs (captures + generations).
 *
 *   GET    — ?action=list (default): 500 newest rows from `merch_library`.
 *          — ?action=videos: recent video posts (joined with `ai_personas`
 *            for author badge) to power the frame-capture UI. `?limit=`
 *            clamped to [1,200], default 60.
 *   POST   — dispatched by `action`:
 *            • `capture` — client-extracted video frame as a data URL;
 *              parses contentType+base64, uploads to
 *              `merch/captures/{id}.{ext}`, INSERTs with source='capture'.
 *            • `generate` — **Phase 5 AI-engine action.** Legacy calls
 *              xAI `grok-imagine-image`; image generation is not yet
 *              ported into `@/lib/ai/`, so this returns 501 until a
 *              shared image-gen helper lands. Preserves the 3 other
 *              actions in the meantime.
 *            • `update` — partial metadata edit (label / category).
 *            • `delete` — deletes Blob + DB row (Blob delete is
 *              best-effort; DB delete always runs).
 *
 *   merch_library is created lazily via `ensureTable()` on every
 *   request — matches legacy fresh-env behaviour.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function ensureTable() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS merch_library (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      image_url TEXT NOT NULL,
      label TEXT,
      category TEXT,
      source_post_id TEXT,
      source_video_url TEXT,
      prompt_used TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_merch_library_created ON merch_library(created_at DESC)`
    .catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_merch_library_source ON merch_library(source)`
    .catch(() => {});
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const action = request.nextUrl.searchParams.get("action") || "list";

  if (action === "videos") {
    const raw = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "60", 10);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 60, 1), 200);
    const videos = await sql`
      SELECT p.id, p.content, p.media_url, p.created_at, p.persona_id,
             a.display_name, a.avatar_emoji
      FROM posts p
      LEFT JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.media_type = 'video'
        AND p.media_url IS NOT NULL
        AND p.media_url != ''
      ORDER BY p.created_at DESC
      LIMIT ${limit}
    `;
    return NextResponse.json({ videos });
  }

  const items = await sql`
    SELECT id, source, image_url, label, category,
           source_post_id, source_video_url, prompt_used, created_at
    FROM merch_library
    ORDER BY created_at DESC
    LIMIT 500
  `;
  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureTable();
  const sql = getDb();
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    image_data?: string;
    label?: string;
    category?: string;
    source_post_id?: string;
    source_video_url?: string;
    prompt?: string;
    id?: string;
  };

  const { action } = body;

  if (action === "capture") {
    const { image_data, label, source_post_id, source_video_url } = body;
    if (!image_data) {
      return NextResponse.json({ error: "image_data required" }, { status: 400 });
    }

    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(image_data);
    if (!match) {
      return NextResponse.json(
        { error: "Invalid image_data format (expected data URL)" },
        { status: 400 },
      );
    }
    const contentType = match[1];
    const buffer = Buffer.from(match[2], "base64");

    const id = randomUUID();
    const ext = contentType.split("/")[1] || "png";
    const blobPath = `merch/captures/${id}.${ext}`;
    const blob = await put(blobPath, buffer, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });

    await sql`
      INSERT INTO merch_library (
        id, source, image_url, label, category,
        source_post_id, source_video_url, prompt_used
      )
      VALUES (
        ${id}, 'capture', ${blob.url}, ${label ?? null}, 'video-frame',
        ${source_post_id ?? null}, ${source_video_url ?? null}, NULL
      )
    `;

    return NextResponse.json({ success: true, id, image_url: blob.url });
  }

  if (action === "generate") {
    // Legacy calls xAI grok-imagine-image. `@/lib/ai/` currently exposes
    // text-only helpers (xaiComplete / claudeComplete / generateText) —
    // no shared image-gen client yet. Defer until a helper lands so all
    // image-generating admin routes can share one circuit breaker +
    // cost-ledger path.
    return NextResponse.json(
      {
        error: "Not implemented in aiglitch-api yet",
        reason:
          "Image generation requires a shared xAI image-gen helper under @/lib/ai/ (circuit breaker + cost ledger parity). The other merch actions (capture/update/delete/list) are fully ported; the generate action unblocks when the image-gen helper lands.",
      },
      { status: 501 },
    );
  }

  if (action === "update") {
    const { id, label, category } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await sql`
      UPDATE merch_library
      SET label = ${label ?? null}, category = ${category ?? null}
      WHERE id = ${id}
    `;
    return NextResponse.json({ success: true });
  }

  if (action === "delete") {
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const rows = (await sql`
      SELECT image_url FROM merch_library WHERE id = ${id}
    `) as unknown as { image_url: string }[];
    const item = rows[0];

    if (item?.image_url) {
      try {
        await del(item.image_url);
      } catch {
        // Best-effort; legacy parity. DB delete still runs below.
      }
    }
    await sql`DELETE FROM merch_library WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
