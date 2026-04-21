/**
 * Direct server-side file upload to Vercel Blob + DB registration.
 *
 * POST /api/content/upload
 *   multipart/form-data with `file` (required) and optional
 *   `folder` (defaults to `"uploads"`). Uploads to
 *   `{folder}/{originalFilename}` with `addRandomSuffix: true` so
 *   concurrent uploads don't collide, then INSERTs a row in
 *   `uploaded_media` with filename, content_type, size_bytes, and
 *   folder.
 *
 * For files that bust the 4.5 MB serverless body limit (big videos
 * especially), the admin UI uses the client-upload flow via
 * `/api/admin/media/upload` + `/api/admin/media/save` instead.
 * THIS route is fine for small files and the Content Studio's
 * simple "add media" button.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const folder = (formData.get("folder") as string | null) ?? "uploads";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  try {
    const blob = await put(`${folder}/${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
    });

    const id = randomUUID();
    const sql = getDb();
    await sql`
      INSERT INTO uploaded_media (id, url, filename, content_type, size_bytes, folder)
      VALUES (
        ${id}, ${blob.url}, ${file.name},
        ${file.type || "application/octet-stream"}, ${file.size}, ${folder}
      )
    `;

    return NextResponse.json({
      success: true,
      media: {
        id,
        url: blob.url,
        filename: file.name,
        content_type: file.type,
        size_bytes: file.size,
        folder,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 },
    );
  }
}
