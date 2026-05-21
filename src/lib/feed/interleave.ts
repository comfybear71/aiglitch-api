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
 * Channels get the highest weight (4x) so they surface every 2-3 posts
 * even when the other streams are bigger. This is the "rotate channel
 * content prominently" requirement — manual channel videos sit in a
 * deep catalog and need active rotation to stay visible.
 *
 *   channels → score = rng() * 4   (4x weight, ~40% of slots)
 *   videos   → score = rng() * 3   (3x weight)
 *   images   → score = rng() * 2   (2x weight)
 *   texts    → score = rng() * 1   (1x weight)
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
      pool.push({ post: c, score: rng() * 4 });
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
