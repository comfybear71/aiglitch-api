/**
 * Channel queries — reads for /api/channels GET, writes for subscribe/unsubscribe.
 *
 * First write-side repo in this project. Patterns established here apply to
 * future write endpoints:
 *   - INSERT + counter UPDATE are sequential, not in a transaction, matching
 *     legacy behaviour (any change would drift the consumer).
 *   - Subscribe uses ON CONFLICT DO NOTHING — idempotent under double-click.
 *   - Unsubscribe only decrements when a row was actually deleted.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

/**
 * Defaults for channel generation config fields. Kept inline here because
 * only this endpoint cares; extract to a shared constants file if/when a
 * second endpoint needs them.
 */
export const CHANNEL_DEFAULTS = {
  showTitlePage: false,
  showDirector: false,
  showCredits: false,
  sceneDuration: 10,
  autoPublishToFeed: true,
} as const;

export interface ChannelHost {
  persona_id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  role: string;
}

export interface ChannelListItem {
  [key: string]: unknown;
  id: string;
  subscribed: boolean;
  personas: ChannelHost[];
  thumbnail: string | null;
}

/** GET: list active + public channels with counts, hosts, thumbnail, subscription. */
export async function listChannels(
  sessionId: string | null,
): Promise<ChannelListItem[]> {
  const sql = getDb();

  const rawChannels = (await sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM channel_personas cp WHERE cp.channel_id = c.id) AS persona_count,
      (SELECT COUNT(*)::int FROM posts p WHERE p.channel_id = c.id AND p.is_reply_to IS NULL) AS actual_post_count
    FROM channels c
    WHERE c.is_active = TRUE AND (c.is_private IS NOT TRUE)
    ORDER BY c.sort_order ASC, c.created_at ASC
  `) as unknown as Array<Record<string, unknown>>;

  const channelIds = rawChannels.map((c) => c.id as string);

  const [subscribedSet, hostsByChannel, thumbnailsByChannel] = await Promise.all([
    resolveSubscriptions(sessionId),
    resolveHosts(channelIds),
    resolveThumbnails(channelIds),
  ]);

  return rawChannels.map((c) => ({
    ...c,
    content_rules: typeof c.content_rules === "string" ? safeJsonParse(c.content_rules) : c.content_rules,
    schedule: typeof c.schedule === "string" ? safeJsonParse(c.schedule) : c.schedule,
    show_title_page: c.show_title_page ?? CHANNEL_DEFAULTS.showTitlePage,
    show_director: c.show_director ?? CHANNEL_DEFAULTS.showDirector,
    show_credits: c.show_credits ?? CHANNEL_DEFAULTS.showCredits,
    scene_count: c.scene_count ?? null,
    scene_duration: c.scene_duration ?? CHANNEL_DEFAULTS.sceneDuration,
    default_director: c.default_director ?? null,
    generation_genre: c.generation_genre ?? null,
    short_clip_mode: c.short_clip_mode ?? false,
    is_music_channel: c.is_music_channel ?? false,
    auto_publish_to_feed: c.auto_publish_to_feed ?? CHANNEL_DEFAULTS.autoPublishToFeed,
    subscribed: subscribedSet.has(c.id as string),
    personas: hostsByChannel.get(c.id as string) ?? [],
    thumbnail:
      (c.banner_url as string | null) ??
      thumbnailsByChannel.get(c.id as string) ??
      null,
  })) as unknown as ChannelListItem[];
}

async function resolveSubscriptions(sessionId: string | null): Promise<Set<string>> {
  if (!sessionId) return new Set();
  const sql = getDb();
  const subs = (await sql`
    SELECT channel_id FROM channel_subscriptions WHERE session_id = ${sessionId}
  `) as unknown as Array<{ channel_id: string }>;
  return new Set(subs.map((s) => s.channel_id));
}

async function resolveHosts(channelIds: string[]): Promise<Map<string, ChannelHost[]>> {
  const map = new Map<string, ChannelHost[]>();
  if (channelIds.length === 0) return map;
  const sql = getDb();
  const hosts = (await sql`
    SELECT cp.channel_id, cp.role,
           a.id AS persona_id, a.username, a.display_name, a.avatar_emoji, a.avatar_url
    FROM channel_personas cp
    JOIN ai_personas a ON cp.persona_id = a.id
    WHERE cp.channel_id = ANY(${channelIds})
    ORDER BY cp.role ASC, a.follower_count DESC
  `) as unknown as Array<{
    channel_id: string;
    role: string;
    persona_id: string;
    username: string;
    display_name: string;
    avatar_emoji: string;
    avatar_url: string | null;
  }>;

  for (const h of hosts) {
    const list = map.get(h.channel_id) ?? [];
    list.push({
      persona_id: h.persona_id,
      username: h.username,
      display_name: h.display_name,
      avatar_emoji: h.avatar_emoji,
      avatar_url: h.avatar_url,
      role: h.role,
    });
    map.set(h.channel_id, list);
  }
  return map;
}

async function resolveThumbnails(channelIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (channelIds.length === 0) return map;
  const sql = getDb();
  const thumbs = (await sql`
    SELECT DISTINCT ON (p.channel_id) p.channel_id AS cid, p.media_url
    FROM posts p
    WHERE p.is_reply_to IS NULL
      AND p.media_url IS NOT NULL
      AND p.media_type IN ('image', 'video')
      AND p.channel_id = ANY(${channelIds})
      AND COALESCE(p.media_source, '') NOT IN
          ('director-premiere', 'director-profile', 'director-scene')
    ORDER BY p.channel_id, p.created_at DESC
  `) as unknown as Array<{ cid: string; media_url: string }>;
  for (const t of thumbs) {
    map.set(t.cid, t.media_url);
  }
  return map;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** POST subscribe. Idempotent (ON CONFLICT DO NOTHING). */
export async function subscribeToChannel(
  sessionId: string,
  channelId: string,
): Promise<void> {
  const sql = getDb();
  const id = randomUUID();
  await sql`
    INSERT INTO channel_subscriptions (id, channel_id, session_id)
    VALUES (${id}, ${channelId}, ${sessionId})
    ON CONFLICT (channel_id, session_id) DO NOTHING
  `;
  await sql`
    UPDATE channels
    SET subscriber_count = subscriber_count + 1
    WHERE id = ${channelId}
  `;
}

/** POST unsubscribe. Only decrements when a row was actually deleted. */
export async function unsubscribeFromChannel(
  sessionId: string,
  channelId: string,
): Promise<void> {
  const sql = getDb();
  const deleted = (await sql`
    DELETE FROM channel_subscriptions
    WHERE channel_id = ${channelId} AND session_id = ${sessionId}
  `) as unknown as { count?: number };
  if ((deleted.count ?? 0) > 0) {
    await sql`
      UPDATE channels
      SET subscriber_count = GREATEST(subscriber_count - 1, 0)
      WHERE id = ${channelId}
    `;
  }
}
