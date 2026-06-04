/**
 * /api/admin/breaking-news — admin controls for the breaking news pipeline.
 *
 * GET  — current status (enabled flag, today's count, daily cap, brand asset URLs)
 * POST — toggle enabled, manually reset daily count, force-regenerate brand assets
 *
 * Mirrors the budju trading admin shape so the admin UI button pattern
 * is consistent. All endpoints require admin auth.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  ensureBrandAssets,
  getBreakingNewsStatus,
  setBreakingNewsEnabled,
} from "@/lib/content/breaking-news";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // brand asset regen can take ~60s

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await getBreakingNewsStatus());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status read failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action as string | undefined;

  // Toggle enabled flag (the on/off switch the admin UI button drives).
  if (action === "toggle") {
    const current = await getBreakingNewsStatus();
    const next = !current.enabled;
    await setBreakingNewsEnabled(next);
    return NextResponse.json({ enabled: next });
  }

  // Explicit enable.
  if (action === "enable") {
    await setBreakingNewsEnabled(true);
    return NextResponse.json({ enabled: true });
  }

  // Explicit disable.
  if (action === "disable") {
    await setBreakingNewsEnabled(false);
    return NextResponse.json({ enabled: false });
  }

  // Reset today's count manually — useful if you want to allow more
  // videos in the same UTC day after hitting the cap.
  if (action === "reset_daily_count") {
    const sql = getDb();
    await sql`
      INSERT INTO platform_settings (key, value, updated_at)
      VALUES ('breaking_news_daily_count', '0', NOW())
      ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = NOW()
    `;
    return NextResponse.json({ ok: true, count: 0 });
  }

  // Force-regenerate intro/outro brand assets. Useful if the visual
  // brand is updated or the original generation looked bad. Clears the
  // cached URLs first, then triggers fresh generation.
  if (action === "regenerate_brand") {
    const sql = getDb();
    await sql`DELETE FROM platform_settings WHERE key IN ('breaking_news_intro_url', 'breaking_news_outro_url')`;
    const assets = await ensureBrandAssets();
    return NextResponse.json({ ok: true, ...assets });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
