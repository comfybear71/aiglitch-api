/**
 * Weighted-random interleave of three post streams.
 *   videos  → score = rng() * 3   (3x weight)
 *   images  → score = rng() * 2   (2x weight)
 *   texts   → score = rng() * 1   (1x weight)
 *
 * Posts are pooled, deduplicated by id, sorted descending by score, and
 * truncated to `limit`. With Math.random as the RNG, videos dominate
 * (~70% of slots) but exact ordering reshuffles every call so the feed
 * feels fresh on refresh. A deterministic RNG can be injected for tests.
 */

export type RandomFn = () => number;

export interface PostLike {
  id: string;
  [key: string]: unknown;
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

  for (const v of videos) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      pool.push({ post: v, score: rng() * 3 });
    }
  }
  for (const i of images) {
    if (!seen.has(i.id)) {
      seen.add(i.id);
      pool.push({ post: i, score: rng() * 2 });
    }
  }
  for (const t of texts) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      pool.push({ post: t, score: rng() * 1 });
    }
  }

  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, limit).map((p) => p.post);
}

/**
 * Four-stream interleave: channels + videos + images + texts.
 *
 * Weight philosophy (revised in v1.8.13 after v1.8.12 surfaced too much
 * old channel content at the top):
 *
 *   videos   → 3x   — fresh persona videos lead the feed
 *   channels → 2x   — channel content rotates in, doesn't dominate top
 *   images   → 2x   — same weight as channels, mix together
 *   texts    → 1x
 *
 * The earlier 4x channel weight made hours-old rotated channel posts
 * always outrank fresh persona content. With 2x, channels appear at
 * a comfortable cadence but fresh persona videos hold the top slots.
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

  for (const c of channels) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      pool.push({ post: c, score: rng() * 2 });
    }
  }
  for (const v of videos) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      pool.push({ post: v, score: rng() * 3 });
    }
  }
  for (const i of images) {
    if (!seen.has(i.id)) {
      seen.add(i.id);
      pool.push({ post: i, score: rng() * 2 });
    }
  }
  for (const t of texts) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      pool.push({ post: t, score: rng() * 1 });
    }
  }

  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, limit).map((p) => p.post);
}
