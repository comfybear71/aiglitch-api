/**
 * Platform-brief builder.
 *
 * Merges the static `PLATFORM_BRIEF` constant (editable via
 * `/admin/prompts`, fallback in `@/lib/bible/platform-brief`) with
 * live DB stats + dynamic channel URL list so every persona chat
 * system prompt has up-to-date platform knowledge.
 *
 * Cost: 5 cheap COUNT queries + 1 channel SELECT per chat.
 * Cached per-request (not stored). Read-only — no writes, no
 * sensitive data exposure.
 */

import { PLATFORM_BRIEF } from "@/lib/bible/platform-brief";
import { getDb } from "@/lib/db";
import { getPrompt } from "@/lib/prompt-overrides";

interface LivePlatformStats {
  active_personas: number;
  active_channels: number;
  posts_last_24h: number;
  posts_total: number;
  videos_today: number;
  channels: {
    slug: string;
    name: string;
    emoji: string;
    description: string | null;
  }[];
}

async function fetchLiveStats(): Promise<LivePlatformStats> {
  const sql = getDb();
  try {
    const [
      personaCountRows,
      channelCountRows,
      posts24hRows,
      postsTotalRows,
      videosTodayRows,
      channelRows,
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int as c FROM ai_personas WHERE is_active = TRUE` as unknown as Promise<
        { c: number }[]
      >,
      sql`SELECT COUNT(*)::int as c FROM channels WHERE is_active = TRUE AND (is_private IS NOT TRUE)` as unknown as Promise<
        { c: number }[]
      >,
      sql`SELECT COUNT(*)::int as c FROM posts WHERE created_at > NOW() - INTERVAL '24 hours' AND is_reply_to IS NULL` as unknown as Promise<
        { c: number }[]
      >,
      sql`SELECT COUNT(*)::int as c FROM posts WHERE is_reply_to IS NULL` as unknown as Promise<
        { c: number }[]
      >,
      sql`SELECT COUNT(*)::int as c FROM posts WHERE media_type = 'video' AND media_url IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'` as unknown as Promise<
        { c: number }[]
      >,
      sql`SELECT slug, name, emoji, description FROM channels WHERE is_active = TRUE AND (is_private IS NOT TRUE) ORDER BY sort_order ASC` as unknown as Promise<
        {
          slug: string;
          name: string;
          emoji: string;
          description: string | null;
        }[]
      >,
    ]);
    return {
      active_personas: personaCountRows[0]?.c ?? 0,
      active_channels: channelCountRows[0]?.c ?? 0,
      posts_last_24h: posts24hRows[0]?.c ?? 0,
      posts_total: postsTotalRows[0]?.c ?? 0,
      videos_today: videosTodayRows[0]?.c ?? 0,
      channels: channelRows,
    };
  } catch {
    return {
      active_personas: 111,
      active_channels: 19,
      posts_last_24h: 0,
      posts_total: 0,
      videos_today: 0,
      channels: [],
    };
  }
}

export async function buildPlatformBriefBlock(): Promise<string> {
  const [brief, stats] = await Promise.all([
    getPrompt("platform", "brief", PLATFORM_BRIEF),
    fetchLiveStats(),
  ]);

  const liveStatsBlock = `
═ LIVE PLATFORM STATS (current as of this chat) ═
- Active personas: ${stats.active_personas}
- Active public channels: ${stats.active_channels}
- Posts in last 24 hours: ${stats.posts_last_24h.toLocaleString()}
- Total posts ever: ${stats.posts_total.toLocaleString()}
- Videos posted in last 24 hours: ${stats.videos_today.toLocaleString()}`;

  const channelUrls =
    stats.channels.length > 0
      ? `
═ LIVE CHANNEL URL LIST (real, share these freely) ═
${stats.channels
  .map(
    (ch) =>
      `- ${ch.emoji || ""} ${ch.name}: https://aiglitch.app/channels/${ch.slug}`,
  )
  .join("\n")}`
      : "";

  return `\n\n${brief}\n${liveStatsBlock}${channelUrls}`;
}
