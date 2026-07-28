/**
 * Admin-controlled auto-social settings (platform_settings keys).
 * Overview UI reads/writes via /api/admin/social-policy.
 */

import { getDb } from "@/lib/db";
import { ALL_PLATFORMS, type MarketingPlatform } from "./types";

const KEY_POSTS_PER_DAY = "social_auto_posts_per_day";
const KEY_PLATFORMS = "social_auto_platforms";
const KEY_FACEBOOK_AUTO = "facebook_auto_post";

const DEFAULT_POSTS_PER_DAY = 3;
const DEFAULT_PLATFORMS: MarketingPlatform[] = ["x", "telegram", "instagram", "facebook"];

export interface SocialAutoPolicy {
  postsPerDay: number;
  platforms: MarketingPlatform[];
  facebookAuto: boolean;
}

function parsePlatforms(raw: string | undefined): MarketingPlatform[] {
  if (!raw?.trim()) return [...DEFAULT_PLATFORMS];
  const allowed = new Set<string>(ALL_PLATFORMS);
  const out: MarketingPlatform[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim().toLowerCase();
    if (allowed.has(p) && !out.includes(p as MarketingPlatform)) {
      out.push(p as MarketingPlatform);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_PLATFORMS];
}

export async function getSocialAutoPolicy(): Promise<SocialAutoPolicy> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT key, value FROM platform_settings
      WHERE key IN (${KEY_POSTS_PER_DAY}, ${KEY_PLATFORMS}, ${KEY_FACEBOOK_AUTO})
    `) as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const postsPerDay = Math.min(
      24,
      Math.max(0, Math.round(Number(map.get(KEY_POSTS_PER_DAY) ?? DEFAULT_POSTS_PER_DAY))),
    );
    const platforms = parsePlatforms(map.get(KEY_PLATFORMS));
    const facebookAuto =
      map.get(KEY_FACEBOOK_AUTO) === undefined
        ? true
        : map.get(KEY_FACEBOOK_AUTO) === "true";
    return { postsPerDay, platforms, facebookAuto };
  } catch {
    return {
      postsPerDay: DEFAULT_POSTS_PER_DAY,
      platforms: [...DEFAULT_PLATFORMS],
      facebookAuto: true,
    };
  }
}

export async function setSocialAutoPolicy(
  patch: Partial<SocialAutoPolicy>,
): Promise<SocialAutoPolicy> {
  const sql = getDb();
  const current = await getSocialAutoPolicy();
  const next: SocialAutoPolicy = {
    postsPerDay:
      patch.postsPerDay !== undefined
        ? Math.min(24, Math.max(0, Math.round(patch.postsPerDay)))
        : current.postsPerDay,
    platforms: patch.platforms ?? current.platforms,
    facebookAuto: patch.facebookAuto ?? current.facebookAuto,
  };

  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${KEY_POSTS_PER_DAY}, ${String(next.postsPerDay)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${String(next.postsPerDay)}, updated_at = NOW()
  `;
  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${KEY_PLATFORMS}, ${next.platforms.join(",")}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${next.platforms.join(",")}, updated_at = NOW()
  `;
  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${KEY_FACEBOOK_AUTO}, ${next.facebookAuto ? "true" : "false"}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${next.facebookAuto ? "true" : "false"}, updated_at = NOW()
  `;

  return next;
}

/** Marketing cron runs every 4h → 6 cycles/day. */
export function postsPerMarketingCycle(postsPerDay: number): number {
  return Math.max(0, Math.ceil(postsPerDay / 6));
}

/** Distinct original posts that got at least one successful platform post today (UTC day). */
export async function countOriginalPostsSpreadToday(): Promise<number> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT COUNT(DISTINCT source_post_id)::int AS c
      FROM marketing_posts
      WHERE status = 'posted'
        AND source_post_id IS NOT NULL
        AND created_at >= date_trunc('day', NOW())
    `) as Array<{ c: number }>;
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Gate for immediate auto-spread (persona-content, etc.).
 * Respects Overview posts/day + enabled platforms (+ Facebook toggle).
 */
export async function canImmediateAutoSpread(): Promise<{
  allowed: boolean;
  policy: SocialAutoPolicy;
  remaining: number;
  platforms: MarketingPlatform[];
}> {
  const policy = await getSocialAutoPolicy();
  const platforms = resolveImmediatePlatforms(policy);
  if (policy.postsPerDay <= 0 || platforms.length === 0) {
    return { allowed: false, policy, remaining: 0, platforms };
  }
  const used = await countOriginalPostsSpreadToday();
  const remaining = Math.max(0, policy.postsPerDay - used);
  return {
    allowed: remaining > 0,
    policy,
    remaining,
    platforms,
  };
}

/** Platforms to use for an immediate spread under current policy. */
export function resolveImmediatePlatforms(
  policy: SocialAutoPolicy,
): MarketingPlatform[] {
  let platforms = [...policy.platforms];
  if (!policy.facebookAuto) {
    platforms = platforms.filter((p) => p !== "facebook");
  }
  return platforms;
}
