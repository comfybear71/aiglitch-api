import { describe, expect, it } from "vitest";
import { interleaveFeed, type PostLike } from "./interleave";

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

  it("favours videos when all RNG outputs are equal (3x weight)", () => {
    // With rng() === 1, scores are videos=3, images=2, texts=1.
    // Top slot must be a video.
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
