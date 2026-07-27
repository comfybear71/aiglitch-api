import { describe, expect, it } from "vitest";

import {
  blasterKeysMatch,
  dedupeBlasterVideos,
  normalizeBlasterTitle,
  normalizeMediaUrl,
} from "./tiktok-blaster-dedupe";

describe("normalizeMediaUrl", () => {
  it("strips query params from blob URLs", () => {
    const base = "https://blob.vercel-storage.com/foo/bar.mp4";
    expect(normalizeMediaUrl(`${base}?v=1`)).toBe(normalizeMediaUrl(base));
  });
});

describe("normalizeBlasterTitle", () => {
  it("uses first line only", () => {
    expect(normalizeBlasterTitle("THE FUTURE IS GLITCHED\n\nMore text")).toBe(
      "the future is glitched",
    );
  });
});

describe("dedupeBlasterVideos", () => {
  it("keeps one row per media_url and counts duplicates", () => {
    const url = "https://blob.vercel-storage.com/ad.mp4";
    const result = dedupeBlasterVideos([
      {
        id: "p1",
        media_url: url,
        content: "Title A",
        created_at: "2026-07-20T10:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
      {
        id: "p2",
        media_url: url,
        content: "Title A",
        created_at: "2026-07-21T10:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
      {
        id: "p3",
        media_url: "https://blob.vercel-storage.com/other.mp4",
        content: "Title B",
        created_at: "2026-07-21T11:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === "p2")?.duplicate_count).toBe(2);
  });

  it("merges rows with same headline but different blob URLs", () => {
    const result = dedupeBlasterVideos([
      {
        id: "p1",
        media_url: "https://blob.vercel-storage.com/a-random.mp4",
        content: "THE FUTURE IS GLITCHED\n\nBody",
        created_at: "2026-07-20T10:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
      {
        id: "p2",
        media_url: "https://blob.vercel-storage.com/b-random.mp4",
        content: "THE FUTURE IS GLITCHED\n\nBody",
        created_at: "2026-07-21T10:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.duplicate_count).toBe(2);
    expect(result[0]!.id).toBe("p2");
  });

  it("keeps different headlines as separate cards", () => {
    const result = dedupeBlasterVideos([
      {
        id: "p1",
        media_url: "https://blob.vercel-storage.com/x1.mp4",
        content: "108 AIs. ONE PLATFORM.",
        created_at: "2026-07-21T10:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
      {
        id: "p2",
        media_url: "https://blob.vercel-storage.com/x2.mp4",
        content: "CHANNELS BY AIG!ITCH",
        created_at: "2026-07-21T09:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
    ]);

    expect(result).toHaveLength(2);
  });

  it("marks group blasted if any sibling post was blasted", () => {
    const url = "https://blob.vercel-storage.com/shared.mp4";
    const result = dedupeBlasterVideos([
      {
        id: "new",
        media_url: url,
        content: "Same",
        created_at: "2026-07-22T10:00:00Z",
        blasted_at: null,
        tiktok_url: null,
      },
      {
        id: "old",
        media_url: url,
        content: "Same",
        created_at: "2026-07-20T10:00:00Z",
        blasted_at: "2026-07-19T10:00:00Z",
        tiktok_url: null,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.blasted_at).toBe("2026-07-19T10:00:00Z");
  });
});

describe("blasterKeysMatch", () => {
  it("matches on title even when urls differ", () => {
    expect(
      blasterKeysMatch(
        { media_url: "https://a/1.mp4", content: "THE FUTURE IS GLITCHED" },
        { media_url: "https://a/2.mp4", content: "THE FUTURE IS GLITCHED\n\nx" },
      ),
    ).toBe(true);
  });
});
