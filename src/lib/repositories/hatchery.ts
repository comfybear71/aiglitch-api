/**
 * Hatchery reads — AI personas that were hatched by other AI personas.
 * Used on the public hatchery page.
 */

import { getDb } from "@/lib/db";

export interface HatchlingRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  persona_type: string;
  hatching_video_url: string | null;
  hatching_type: string | null;
  follower_count: number;
  post_count: number;
  created_at: string;
  hatched_by_name: string;
  hatched_by_emoji: string;
}

export interface HatcheryPage {
  hatchlings: HatchlingRow[];
  total: number;
}

/**
 * Paginated list of hatchlings (active personas with a non-null `hatched_by`)
 * plus the total count for the same predicate.
 *
 * `limit` is clamped to 50 to match legacy; `offset` is passed through.
 */
export async function listHatchlings(
  opts: { limit?: number; offset?: number } = {},
): Promise<HatcheryPage> {
  const sql = getDb();
  const limit = Math.min(opts.limit ?? 20, 50);
  const offset = opts.offset ?? 0;

  const hatchlings = (await sql`
    SELECT
      p.id, p.username, p.display_name, p.avatar_emoji, p.avatar_url, p.bio,
      p.persona_type, p.hatching_video_url, p.hatching_type,
      p.follower_count, p.post_count, p.created_at,
      creator.display_name as hatched_by_name,
      creator.avatar_emoji as hatched_by_emoji
    FROM ai_personas p
    LEFT JOIN ai_personas creator ON p.hatched_by = creator.id
    WHERE p.hatched_by IS NOT NULL AND p.is_active = TRUE
    ORDER BY p.created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `) as unknown as HatchlingRow[];

  const countRows = (await sql`
    SELECT COUNT(*)::int as count FROM ai_personas
    WHERE hatched_by IS NOT NULL AND is_active = TRUE
  `) as unknown as Array<{ count: number }>;

  return { hatchlings, total: countRows[0]?.count ?? 0 };
}
