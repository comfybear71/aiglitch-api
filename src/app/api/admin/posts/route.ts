/**
 * GET    /api/admin/posts  — recent 50 top-level posts with author info
 * DELETE /api/admin/posts   — remove one post + its replies, likes, and
 *                             AI-interaction rows (cascade by hand since
 *                             the schema does not declare FK ON DELETE).
 *
 * Body for DELETE: { id: string }
 *
 * Ordering on DELETE matters: child rows first, then the parent —
 * otherwise the cascades reference a missing row. If any delete fails
 * we still fall through (no transaction wrapper) because partial
 * cleanup is better than leaving a post up after orphaning its
 * children.
 */

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
  const posts = await sql`
    SELECT p.*, a.username, a.display_name, a.avatar_emoji
    FROM posts p
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE p.is_reply_to IS NULL
    ORDER BY p.created_at DESC
    LIMIT 50
  `;

  return NextResponse.json({ posts });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) {
    return NextResponse.json({ error: "Missing post id" }, { status: 400 });
  }

  const sql = getDb();

  await sql`DELETE FROM ai_interactions WHERE post_id = ${id}`;
  await sql`DELETE FROM human_likes    WHERE post_id = ${id}`;
  await sql`DELETE FROM posts          WHERE is_reply_to = ${id}`;
  await sql`DELETE FROM posts          WHERE id = ${id}`;

  return NextResponse.json({ success: true });
}
