/**
 * GET /api/admin/heygen/catalog
 *
 * Lists every avatar + voice available to the configured HeyGen
 * account, in a single JSON response. Used to find the avatar_id /
 * voice_id strings for env vars like HEYGEN_NEWS_ANCHOR_AVATAR_ID
 * without having to navigate the HeyGen dashboard.
 *
 * Admin auth required (calls HeyGen's catalog APIs, which counts
 * against rate limits even though it doesn't generate video).
 *
 * Response:
 *   {
 *     avatars: [{ avatar_id, avatar_name, gender, preview_image_url, … }],
 *     voices:  [{ voice_id, name, gender, language, … }],
 *     suggestions: { news_anchor_avatars: […], news_anchor_voices: […] }
 *   }
 *
 * `suggestions` is a heuristic filter that surfaces likely-fit
 * candidates for the breaking-news anchor role (professional-looking
 * names, news/broadcaster-tagged voices). Read-through only — it's
 * just a hint.
 *
 * 503 when HEYGEN_API_KEY isn't set, so the operator knows to add it.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  listAvatars,
  listVoices,
  isHeyGenConfigured,
  type HeyGenAvatarSummary,
  type HeyGenVoiceSummary,
} from "@/lib/ai/heygen";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Rough "this could be a news anchor avatar" filter. Looks for
 * generic-professional descriptor words in the avatar name. Avoids
 * cartoon / character / themed names.
 */
function looksLikeNewsAnchor(av: HeyGenAvatarSummary): boolean {
  const name = av.avatar_name?.toLowerCase() ?? "";
  const positive = /\b(professional|business|office|suit|formal|anchor|presenter|reporter)\b/.test(
    name,
  );
  const negative = /\b(cartoon|anime|fantasy|warrior|robot|game|kid|child|santa)\b/.test(
    name,
  );
  return positive && !negative;
}

/**
 * Voices that sound newscast-y. Filter by language=English plus
 * keywords in the voice name.
 */
function looksLikeNewsVoice(v: HeyGenVoiceSummary): boolean {
  const isEnglish = (v.language ?? "").toLowerCase().includes("english");
  if (!isEnglish) return false;
  const name = v.name?.toLowerCase() ?? "";
  return /\b(news|broadcaster|announcer|professional|narrator|formal)\b/.test(
    name,
  );
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isHeyGenConfigured()) {
    return NextResponse.json(
      {
        error: "HEYGEN_API_KEY not set",
        hint: "Add HEYGEN_API_KEY to Vercel env vars (Settings → Environment Variables → Production).",
      },
      { status: 503 },
    );
  }

  try {
    const [avatars, voices] = await Promise.all([listAvatars(), listVoices()]);
    const newsAnchorAvatars = avatars.filter(looksLikeNewsAnchor);
    const newsAnchorVoices = voices.filter(looksLikeNewsVoice);
    return NextResponse.json({
      counts: {
        avatars: avatars.length,
        voices: voices.length,
        news_anchor_avatars: newsAnchorAvatars.length,
        news_anchor_voices: newsAnchorVoices.length,
      },
      suggestions: {
        news_anchor_avatars: newsAnchorAvatars,
        news_anchor_voices: newsAnchorVoices,
      },
      avatars,
      voices,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin/heygen/catalog] ${msg}`);
    return NextResponse.json(
      { error: `HeyGen catalog fetch failed: ${msg}` },
      { status: 500 },
    );
  }
}
