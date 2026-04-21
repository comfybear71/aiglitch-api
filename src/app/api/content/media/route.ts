/**
 * Paginated list + delete for the `uploaded_media` table.
 *
 * GET /api/content/media?limit=50&offset=0&folder=uploads
 *   — returns `{media, stats, pagination}`. `stats` carries the
 *     whole-table totals (count + sum of size_bytes).
 *
 * DELETE /api/content/media
 *   — body `{ id }`. Deletes the DB row AND best-efforts the Blob
 *     file via `@vercel/blob#del`. Blob deletion failures are
 *     swallowed — the file might already be gone.
 *
 * Limit capped at 200. No auth on GET? — admin-only per legacy
 * parity. Same for DELETE.
 */

import { del as blobDel } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const url = request.nextUrl;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Number(url.searchParams.get("offset")) || 0;
  const folder = url.searchParams.get("folder");

  const media = folder
    ? await sql`
        SELECT id, url, filename, content_type, size_bytes, folder, created_at
        FROM uploaded_media
        WHERE folder = ${folder}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT id, url, filename, content_type, size_bytes, folder, created_at
        FROM uploaded_media
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  const totalsRows = (await sql`
    SELECT COUNT(*) as total, COALESCE(SUM(size_bytes), 0) as total_bytes
    FROM uploaded_media
  `) as unknown as { total: string; total_bytes: string }[];
  const totals = totalsRows[0] ?? { total: "0", total_bytes: "0" };

  const mediaArr = media as unknown[];
  return NextResponse.json({
    media: mediaArr,
    stats: {
      total: Number(totals.total),
      total_size_bytes: Number(totals.total_bytes),
    },
    pagination: { limit, offset, returned: mediaArr.length },
  });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT url FROM uploaded_media WHERE id = ${body.id}
  `) as unknown as { url: string }[];
  const media = rows[0];
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  try {
    await blobDel(media.url);
  } catch {
    // best-effort — file might already be gone
  }

  await sql`DELETE FROM uploaded_media WHERE id = ${body.id}`;

  return NextResponse.json({ success: true, message: "Media deleted" });
}
