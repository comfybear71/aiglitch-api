import { describe, expect, it } from "vitest";
import {
  interleaveFeed,
  interleaveFeedWithChannels,
  type PostLike,
} from "./interleave";

function mkPosts(prefix: string, count: number): PostLike[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));
}

/** Predictable RNG that cycles through fixed values. */
function fixedRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

describe("interleaveFeed", () => {
  it("returns at most `limit` posts", () => {
    const result = interleaveFeed(
      mkPosts("v", 5),
      mkPosts("i", 5),
      mkPosts("t", 5),
      8,
    );
    expect(result).toHaveLength(8);
  });

  it("returns all posts when total < limit", () => {
    const result = interleaveFeed(
      mkPosts("v", 2),
      mkPosts("i", 1),
      mkPosts("t", 1),
      20,
    );
    expect(result).toHaveLength(4);
  });

  it("deduplicates posts with the same id across streams", () => {
    const shared: PostLike = { id: "dup-1" };
    const result = interleaveFeed([shared], [shared], [shared], 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("dup-1");
  });

  it("favours videos when all RNG outputs are equal at same position (3x weight)", () => {
    // v1.8.16: score = (1000 - pos*4) + weight*5 + rng()*3
    // At position 0 with rng=1: v=1018, i=1013, t=1008. Videos lead.
    const result = interleaveFeed(
      mkPosts("v", 1),
      mkPosts("i", 1),
      mkPosts("t", 1),
      3,
      () => 1,
    );
    expect(result.map((p) => p.id)).toEqual(["v-0", "i-0", "t-0"]);
  });

  it("is deterministic given a deterministic RNG", () => {
    const rng1 = fixedRng([0.1, 0.5, 0.9, 0.2, 0.7]);
    const rng2 = fixedRng([0.1, 0.5, 0.9, 0.2, 0.7]);
    const a = interleaveFeed(mkPosts("v", 2), mkPosts("i", 2), mkPosts("t", 1), 5, rng1);
    const b = interleaveFeed(mkPosts("v", 2), mkPosts("i", 2), mkPosts("t", 1), 5, rng2);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
  });

  it("returns empty array when all streams are empty", () => {
    expect(interleaveFeed([], [], [], 10)).toEqual([]);
  });

  it("preserves original post fields", () => {
    const post = { id: "v-0", content: "hello", extra: 42 };
    const result = interleaveFeed([post], [], [], 1);
    expect(result[0]).toEqual(post);
  });
});

describe("interleaveFeedWithChannels", () => {
  it("returns at most `limit` posts across all four streams", () => {
    const result = interleaveFeedWithChannels(
      mkPosts("c", 5),
      mkPosts("v", 5),
      mkPosts("i", 5),
      mkPosts("t", 5),
      8,
    );
    expect(result).toHaveLength(8);
  });

  it("ranks videos first, then channels/images tied, then texts at position 0", () => {
    // v1.8.16: score = (1000 - pos*4) + weight*5 + rng()*3
    // At pos 0 with rng=1: v=1018, c=1013, i=1013, t=1008.
    // Channels and images tie at 1013 — sort is unstable so we just verify
    // videos lead and texts trail.
    const result = interleaveFeedWithChannels(
      mkPosts("c", 1),
      mkPosts("v", 1),
      mkPosts("i", 1),
      mkPosts("t", 1),
      4,
      () => 1,
    );
    expect(result[0]?.id).toBe("v-0");
    expect(result[3]?.id).toBe("t-0");
    expect(result.map((p) => p.id).sort()).toEqual(["c-0", "i-0", "t-0", "v-0"]);
  });

  it("deduplicates across all four streams", () => {
    const shared: PostLike = { id: "dup-1" };
    const result = interleaveFeedWithChannels(
      [shared],
      [shared],
      [shared],
      [shared],
      10,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("dup-1");
  });

  it("interleaves streams by position with weight tiebreakers (v1.8.16)", () => {
    // v1.8.16: score = (1000 - pos*4) + weight*5 + rng()*3
    // With 8 of each stream at limit=20 and rng=1, top of feed should
    // alternate roughly by position (v0, c0/i0, t0, v1, c1/i1, t1, v2...)
    // because position decay (4 per step) is small enough that videos
    // at position k+1 outrank channels at position k+2 but not k+1.
    const result = interleaveFeedWithChannels(
      mkPosts("c", 8),
      mkPosts("v", 8),
      mkPosts("i", 8),
      mkPosts("t", 8),
      20,
      () => 1,
    );
    // All four streams should contribute to top 20 when supply is balanced.
    const videoCount = result.filter((p) => p.id.startsWith("v-")).length;
    const channelCount = result.filter((p) => p.id.startsWith("c-")).length;
    const imageCount = result.filter((p) => p.id.startsWith("i-")).length;
    const textCount = result.filter((p) => p.id.startsWith("t-")).length;
    expect(videoCount).toBeGreaterThanOrEqual(4);
    expect(channelCount).toBeGreaterThanOrEqual(3);
    expect(imageCount).toBeGreaterThanOrEqual(3);
    expect(textCount).toBeGreaterThanOrEqual(2);
    // v-0 must lead (highest score at pos 0 with rng=1)
    expect(result[0]?.id).toBe("v-0");
  });

  it("returns empty array when all four streams are empty", () => {
    expect(interleaveFeedWithChannels([], [], [], [], 10)).toEqual([]);
  });

  it("falls back gracefully when only channels are supplied", () => {
    const result = interleaveFeedWithChannels(
      mkPosts("c", 3),
      [],
      [],
      [],
      10,
    );
    expect(result).toHaveLength(3);
    expect(result.every((p) => p.id.startsWith("c-"))).toBe(true);
  });
});
