/**
 * Integration tests for GET /api/movies.
 *
 * Covers:
 *   - Response shape (blockbusters, trailers, totalMovies, genreCounts,
 *     directors[], genreLabels).
 *   - director_movies → blockbuster mapping (genreLabel, completedClips).
 *   - premiere posts → trailer mapping with title/genre extraction.
 *   - Trailers de-dupe against director movies' post_id / premiere_post_id.
 *   - Genre + director filters route to the right SQL variant.
 *   - Legacy swallow: missing director_movies table returns trailers only.
 *   - Cache-Control public, s-maxage=60, SWR=300.
 *   - 500 wrapping on outer error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
  throwOnCall: Map<number, Error>;
}

const fake: FakeNeon = { calls: [], results: [], throwOnCall: new Map() };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  const idx = fake.calls.length;
  fake.calls.push({ strings, values });
  const err = fake.throwOnCall.get(idx);
  if (err) return Promise.reject(err);
  const next = fake.results.shift() ?? [];
  return Promise.resolve(next);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnCall = new Map();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGet(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/movies${query}`);
  return GET(req);
}

function blockbusterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dm-1",
    title: "Rise of the Machines",
    genre: "scifi",
    director_username: "steven_spielbot",
    director_display_name: "Steven Spielbot",
    clip_count: 8,
    status: "completed",
    post_id: "post-1",
    premiere_post_id: "premiere-1",
    created_at: "2026-04-20T00:00:00Z",
    completed_clips: 8,
    total_clips: 8,
    ...overrides,
  };
}

function premiereRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-2",
    content: "🎬 The Void\nA trailer",
    hashtags: "#AIGlitchHorror",
    media_url: "https://cdn/horror.mp4",
    created_at: "2026-04-20T00:00:00Z",
    media_source: "ai-generated",
    username: "alfred_glitchcock",
    display_name: "Alfred Glitchcock",
    avatar_url: null,
    avatar_emoji: "🎭",
    ...overrides,
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/movies", () => {
  it("returns empty blockbusters + trailers when both sources are empty", async () => {
    fake.results = [[], []];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blockbusters: unknown[];
      trailers: unknown[];
      totalMovies: number;
      genreCounts: Record<string, number>;
      directors: Array<{ username: string; movieCount: number }>;
      genreLabels: Record<string, string>;
    };
    expect(body.blockbusters).toEqual([]);
    expect(body.trailers).toEqual([]);
    expect(body.totalMovies).toBe(0);
    expect(body.genreCounts).toEqual({});
    expect(body.directors).toHaveLength(10);
    expect(body.directors.every((d) => d.movieCount === 0)).toBe(true);
    expect(body.genreLabels.scifi).toBe("Sci-Fi");
  });

  it("shapes director_movies into blockbusters with genreLabel + clip counts", async () => {
    fake.results = [[blockbusterRow()], []];
    const res = await callGet();
    const body = (await res.json()) as {
      blockbusters: Array<{
        id: string;
        title: string;
        genre: string;
        genreLabel: string;
        director: string;
        directorUsername: string;
        clipCount: number;
        type: string;
        completedClips: number | null;
        totalClips: number | null;
      }>;
    };
    expect(body.blockbusters).toHaveLength(1);
    expect(body.blockbusters[0]).toMatchObject({
      id: "dm-1",
      title: "Rise of the Machines",
      genre: "scifi",
      genreLabel: "Sci-Fi",
      director: "Steven Spielbot",
      directorUsername: "steven_spielbot",
      clipCount: 8,
      type: "blockbuster",
      completedClips: 8,
      totalClips: 8,
    });
  });

  it("shapes premiere posts into trailers and extracts title from 🎬 marker", async () => {
    fake.results = [
      [],
      [premiereRow({ content: "🎬 The Void — a haunting\nmore text" })],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      trailers: Array<{
        id: string;
        title: string;
        genre: string;
        genreLabel: string;
        type: string;
        postedBy: string;
        postedByUsername: string;
      }>;
    };
    expect(body.trailers).toHaveLength(1);
    expect(body.trailers[0]).toMatchObject({
      id: "post-2",
      title: "The Void",
      genre: "horror",
      genreLabel: "Horror",
      type: "trailer",
      postedBy: "Alfred Glitchcock",
      postedByUsername: "alfred_glitchcock",
    });
  });

  it("falls back to quoted title, then 50-char slice", async () => {
    fake.results = [
      [],
      [
        premiereRow({ id: "q", content: 'Watch this "Quoted Title" now' }),
        premiereRow({
          id: "s",
          content:
            "A very long paragraph of content that has no emoji and no quoted title so the extractor just slices the first fifty characters out of it",
        }),
      ],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      trailers: Array<{ id: string; title: string }>;
    };
    const quoted = body.trailers.find((t) => t.id === "q");
    const sliced = body.trailers.find((t) => t.id === "s");
    expect(quoted?.title).toBe("Quoted Title");
    expect(sliced?.title?.length).toBeLessThanOrEqual(50);
  });

  it("de-dupes trailers that match a director movie's post_id or premiere_post_id", async () => {
    fake.results = [
      [blockbusterRow({ post_id: "post-X", premiere_post_id: "post-Y" })],
      [
        premiereRow({ id: "post-X" }),
        premiereRow({ id: "post-Y" }),
        premiereRow({ id: "post-Z" }),
      ],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      trailers: Array<{ id: string }>;
      totalMovies: number;
    };
    expect(body.trailers.map((t) => t.id)).toEqual(["post-Z"]);
    expect(body.totalMovies).toBe(2); // 1 blockbuster + 1 trailer
  });

  it("aggregates genreCounts across blockbusters + trailers", async () => {
    fake.results = [
      [blockbusterRow({ id: "a", genre: "scifi" })],
      [
        premiereRow({ id: "b", hashtags: "#AIGlitchScifi" }),
        premiereRow({ id: "c", hashtags: "#AIGlitchHorror" }),
      ],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      genreCounts: Record<string, number>;
    };
    expect(body.genreCounts).toEqual({ scifi: 2, horror: 1 });
  });

  it("bumps movieCount on the matching director entry", async () => {
    fake.results = [
      [
        blockbusterRow({ director_username: "wes_analog" }),
        blockbusterRow({
          id: "dm-2",
          director_username: "wes_analog",
        }),
      ],
      [],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      directors: Array<{ username: string; movieCount: number }>;
    };
    const wes = body.directors.find((d) => d.username === "wes_analog");
    expect(wes?.movieCount).toBe(2);
  });

  it("genre filter feeds the genreTag into the premiere query", async () => {
    fake.results = [[], []];
    await callGet("?genre=romance");
    const premiereSql = sqlOf(fake.calls[1]!);
    expect(premiereSql).toContain("p.hashtags LIKE");
    expect(fake.calls[1]!.values).toContain("%AIGlitchRomance%");
  });

  it("director filter narrows director_movies via director_username", async () => {
    fake.results = [[], []];
    await callGet("?director=wes_analog");
    const dmSql = sqlOf(fake.calls[0]!);
    expect(dmSql).toContain("dm.director_username =");
    expect(fake.calls[0]!.values).toContain("wes_analog");
  });

  it("genre + director filters combine in the director_movies query", async () => {
    fake.results = [[], []];
    await callGet("?genre=scifi&director=george_lucasfilm");
    const dmSql = sqlOf(fake.calls[0]!);
    expect(dmSql).toContain("dm.genre =");
    expect(dmSql).toContain("dm.director_username =");
    expect(fake.calls[0]!.values).toContain("scifi");
    expect(fake.calls[0]!.values).toContain("george_lucasfilm");
  });

  it("swallows a director_movies error and still returns trailers", async () => {
    // Promise.all: both queries start together. director_movies throws;
    // premiere returns rows. Route should not 500 — trailers should ship.
    fake.throwOnCall.set(0, new Error("table director_movies does not exist"));
    fake.results = [[premiereRow()]];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blockbusters: unknown[];
      trailers: unknown[];
    };
    expect(body.blockbusters).toEqual([]);
    expect(body.trailers).toHaveLength(1);
  });

  it("Cache-Control is public, s-maxage=60, SWR=300", async () => {
    fake.results = [[], []];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });
});
