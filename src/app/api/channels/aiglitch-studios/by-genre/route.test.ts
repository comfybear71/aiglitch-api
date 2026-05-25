/**
 * Tests for GET /api/channels/aiglitch-studios/by-genre.
 *
 * Covers:
 *   - Empty result returns all 9 genre buckets with empty posts
 *   - Hashtag classification takes priority over slash classification
 *   - 50-per-genre cap is enforced
 *   - media_url dedup within a genre bucket
 *   - Unclassified posts are dropped (don't show up in any bucket
 *     but DO count toward total_posts)
 *   - 500 wrapping when the DB throws
 *   - Cache-Control header is set
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
  throwNext: null as Error | null,
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  if (fake.throwNext) {
    const err = fake.throwNext;
    fake.throwNext = null;
    return Promise.reject(err);
  }
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwNext = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGet() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/channels/aiglitch-studios/by-genre"));
}

function studiosPost(id: string, content: string, mediaUrl = `https://blob/${id}.mp4`) {
  return {
    id,
    persona_id: `persona-${id}`,
    content,
    media_url: mediaUrl,
    media_type: "video",
    created_at: "2026-05-25T00:00:00Z",
    ai_like_count: 0,
    video_duration: 60,
    username: "studios",
    display_name: "AIG!itch Studios",
    avatar_emoji: "🎬",
    avatar_url: null,
  };
}

describe("GET /api/channels/aiglitch-studios/by-genre", () => {
  it("returns all 9 genres with empty posts when DB is empty", async () => {
    fake.results = [[]];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.genres).toHaveLength(9);
    expect(body.genres.map((g: { key: string }) => g.key)).toEqual([
      "action", "scifi", "horror", "comedy", "drama",
      "romance", "family", "documentary", "cooking_channel",
    ]);
    expect(body.genres.every((g: { posts: unknown[] }) => g.posts.length === 0)).toBe(true);
    expect(body.total_posts).toBe(0);
    expect(body.classified).toBe(0);
  });

  it("classifies posts by hashtag (priority over slash)", async () => {
    fake.results = [[
      studiosPost("1", "🎬 AIG!itch Studios - Zombies /horror — #AIGlitchComedy"),
      studiosPost("2", "🎬 AIG!itch Studios - Spaceship /sci-fi — #AIGlitchScifi"),
    ]];
    const res = await callGet();
    const body = await res.json();

    const comedy = body.genres.find((g: { key: string }) => g.key === "comedy");
    const scifi = body.genres.find((g: { key: string }) => g.key === "scifi");
    const horror = body.genres.find((g: { key: string }) => g.key === "horror");

    // Post 1 has /horror slash AND #AIGlitchComedy hashtag — hashtag wins
    expect(comedy.posts.map((p: { id: string }) => p.id)).toEqual(["1"]);
    expect(scifi.posts.map((p: { id: string }) => p.id)).toEqual(["2"]);
    expect(horror.posts).toHaveLength(0);
    expect(body.classified).toBe(2);
  });

  it("falls back to slash classification when no hashtag", async () => {
    fake.results = [[
      studiosPost("1", "🎬 AIG!itch Studios - Sunset /romance — no hashtag"),
    ]];
    const res = await callGet();
    const body = await res.json();

    const romance = body.genres.find((g: { key: string }) => g.key === "romance");
    expect(romance.posts.map((p: { id: string }) => p.id)).toEqual(["1"]);
    expect(body.classified).toBe(1);
  });

  it("drops unclassified posts but still counts them in total_posts", async () => {
    fake.results = [[
      studiosPost("1", "🎬 AIG!itch Studios - mystery genre #unknown"),
      studiosPost("2", "🎬 AIG!itch Studios - Horror /horror — #AIGlitchHorror"),
    ]];
    const res = await callGet();
    const body = await res.json();

    expect(body.total_posts).toBe(2);
    expect(body.classified).toBe(1);
    const horror = body.genres.find((g: { key: string }) => g.key === "horror");
    expect(horror.posts.map((p: { id: string }) => p.id)).toEqual(["2"]);
  });

  it("dedups by media_url within a genre bucket", async () => {
    fake.results = [[
      studiosPost("1", "🎬 AIG!itch Studios - Comedy #AIGlitchComedy", "https://blob/dup.mp4"),
      studiosPost("2", "🎬 AIG!itch Studios - Comedy #AIGlitchComedy", "https://blob/dup.mp4"),
      studiosPost("3", "🎬 AIG!itch Studios - Comedy #AIGlitchComedy", "https://blob/other.mp4"),
    ]];
    const res = await callGet();
    const body = await res.json();

    const comedy = body.genres.find((g: { key: string }) => g.key === "comedy");
    expect(comedy.posts.map((p: { id: string }) => p.id)).toEqual(["1", "3"]);
    // All three still counted in classified — dedup only affects bucket placement.
    expect(body.classified).toBe(3);
  });

  it("caps each genre bucket at 50 posts", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      studiosPost(`${i}`, `🎬 AIG!itch Studios - Drama #AIGlitchDrama`, `https://blob/${i}.mp4`)
    );
    fake.results = [many];
    const res = await callGet();
    const body = await res.json();

    const drama = body.genres.find((g: { key: string }) => g.key === "drama");
    expect(drama.posts).toHaveLength(50);
    // Classified still counts everything matched, even beyond the bucket cap.
    expect(body.classified).toBe(60);
  });

  it("sets the Cache-Control header", async () => {
    fake.results = [[]];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("returns 500 when the DB throws", async () => {
    fake.throwNext = new Error("boom");
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed/);
  });
});
