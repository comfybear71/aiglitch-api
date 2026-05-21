/**
 * Weighted-random interleave of three post streams.
 *   videos  → score = positionBonus + rng() * 3   (3x weight)
 *   images  → score = positionBonus + rng() * 2   (2x weight)
 *   texts   → score = positionBonus + rng() * 1   (1x weight)
 *
 * Where positionBonus = (streamSize - sqlPosition) * 100 — preserves the
 * SQL ORDER BY freshness ranking so the freshest posts within each stream
 * lead, while the rng() * weight portion provides cross-stream tiebreaking
 * (videos still beat texts of equal SQL rank).
 *
 * Posts are pooled, deduplicated by id, sorted descending by score, and
 * truncated to `limit`. A deterministic RNG can be injected for tests.
 */

export type RandomFn = () => number;

export interface PostLike {
  id: string;
  [key: string]: unknown;
}

function scoreOf(position: number, weight: number, rng: RandomFn): number {
  // Position bonus dominates within ~250 slots; weight breaks ties between
  // streams at the same position; rng adds small variety. Tuned so the feed
  // alternates v/c/v/c... pattern at the top, with videos roughly every
  // 2-3 slots once supply imbalance kicks in.
  return Math.max(0, 1000 - position * 4) + weight * 5 + rng() * 3;
}

export function interleaveFeed<T extends PostLike>(
  videos: T[],
  images: T[],
  texts: T[],
  limit: number,
  rng: RandomFn = Math.random,
): T[] {
  const seen = new Set<string>();
  const pool: { post: T; score: number }[] = [];

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i]!;
    if (!seen.has(v.id)) {
      seen.add(v.id);
      pool.push({ post: v, score: scoreOf(i, 3, rng) });
    }
  }
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    if (!seen.has(img.id)) {
      seen.add(img.id);
      pool.push({ post: img, score: scoreOf(i, 2, rng) });
    }
  }
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]!;
    if (!seen.has(t.id)) {
      seen.add(t.id);
      pool.push({ post: t, score: scoreOf(i, 1, rng) });
    }
  }

  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, limit).map((p) => p.post);
}

/**
 * Four-stream interleave: channels + videos + images + texts.
 *
 * Weight philosophy (revised in v1.8.16 to preserve SQL ordering):
 *
 *   videos   → 3x   — fresh persona videos lead the feed
 *   channels → 2x   — channel content rotates in, doesn't dominate top
 *   images   → 2x   — same weight as channels, mix together
 *   texts    → 1x
 *
 * Score for each post = `(streamSize - sqlPosition) * 100 + rng() * weight`.
 * The positionBonus preserves the SQL ORDER BY ranking (freshest first within
 * each stream); rng * weight breaks ties between streams at the same position.
 * Earlier versions used pure rng() * weight, which randomized the freshness
 * ordering away — a 13-day-old video and a 1-day-old video would compete
 * with equal chance.
 *
 * Same dedup + score-sort + slice-to-limit shape as `interleaveFeed`.
 * A deterministic RNG can be injected for tests.
 */
export function interleaveFeedWithChannels<T extends PostLike>(
  channels: T[],
  videos: T[],
  images: T[],
  texts: T[],
  limit: number,
  rng: RandomFn = Math.random,
): T[] {
  const seen = new Set<string>();
  const pool: { post: T; score: number }[] = [];

  for (let i = 0; i < channels.length; i++) {
    const c = channels[i]!;
    if (!seen.has(c.id)) {
      seen.add(c.id);
      pool.push({ post: c, score: scoreOf(i, 2, rng) });
    }
  }
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i]!;
    if (!seen.has(v.id)) {
      seen.add(v.id);
      pool.push({ post: v, score: scoreOf(i, 3, rng) });
    }
  }
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    if (!seen.has(img.id)) {
      seen.add(img.id);
      pool.push({ post: img, score: scoreOf(i, 2, rng) });
    }
  }
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]!;
    if (!seen.has(t.id)) {
      seen.add(t.id);
      pool.push({ post: t, score: scoreOf(i, 1, rng) });
    }
  }

  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, limit).map((p) => p.post);
}
