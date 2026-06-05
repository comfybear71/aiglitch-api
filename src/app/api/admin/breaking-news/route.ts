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
  forceTriggerBreakingNews,
  getBreakingNewsStatus,
  setBreakingNewsEnabled,
} from "@/lib/content/breaking-news";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 800s (~13min) to cover the worst-case first-run scenario:
//   intro (~3min) + outro (~3min) + presenter (~3min || parallel with field)
//   + field (~3min) + stitch + upload + post + spread.
// Once brand assets exist in Blob, subsequent runs skip intro/outro
// and complete in ~3-4 min. The 300s default isn't enough for first run.
export const maxDuration = 800;

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

  // One-shot data repair: fix posts that were inserted with the
  // literal "news_feed_ai" string as persona_id (bug pre-v1.43.4)
  // instead of the real ai_personas.id. Re-points them so the For You
  // feed JOIN succeeds.
  if (action === "repair_orphan_posts") {
    const sql = getDb();
    try {
      const personaRows = (await sql`
        SELECT id FROM ai_personas WHERE username = 'news_feed_ai' AND is_active = TRUE LIMIT 1
      `) as Array<{ id: string }>;
      if (personaRows.length === 0) {
        return NextResponse.json(
          { error: "news_feed_ai persona not found in ai_personas" },
          { status: 500 },
        );
      }
      const realId = personaRows[0]!.id;
      const updateResult = (await sql`
        UPDATE posts
        SET persona_id = ${realId}
        WHERE persona_id = 'news_feed_ai'
          AND media_source = 'breaking-news'
        RETURNING id
      `) as Array<{ id: string }>;
      return NextResponse.json({
        ok: true,
        repaired: updateResult.length,
        repointed_to_persona_id: realId,
        post_ids: updateResult.map((r) => r.id),
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Repair failed" },
        { status: 500 },
      );
    }
  }

  // Force-trigger the breaking-news pipeline against existing topics
  // that don't yet have a breaking_video_url. Useful for end-to-end
  // verification without waiting for natural topic expiry. Respects
  // the daily cap + enabled toggle. Slow — takes 3-5 min per video.
  if (action === "force_trigger") {
    const max = Math.max(
      1,
      Math.min(2, Number(body.max_topics ?? 1)),
    );
    const results = await forceTriggerBreakingNews(max);
    return NextResponse.json({ ok: true, results });
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
