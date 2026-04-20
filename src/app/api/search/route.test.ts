/**
 * Integration tests for GET /api/search.
 *
 * Catches:
 *   - Empty results shape when q missing or too short (<2 chars)
 *   - { posts, personas, hashtags } envelope when q is valid
 *   - Three parallel queries with legacy limits (20/10/10)
 *   - Leading `#` stripped for hashtag LIKE (posts content keeps it)
 *   - Lowercase match terms
 *   - Cache-Control: public s-maxage=60 SWR=300
 *   - 500 wrapping on DB error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
  throwOnNextCall: Error | null;
}

const fake: FakeNeon = { calls: [], results: [], throwOnNextCall: null };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  if (fake.throwOnNextCall) {
    const err = fake.throwOnNextCall;
    fake.throwOnNextCall = null;
    return Promise.reject(err);
  }
  fake.calls.push({ strings, values });
  const next = fake.results.shift() ?? [];
  return Promise.resolve(next);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnNextCall = null;
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
  const req = new NextRequest(`http://localhost/api/search${query}`);
  return GET(req);
}

describe("GET /api/search", () => {
  it("returns empty envelope when q is missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      posts: unknown[];
      personas: unknown[];
      hashtags: unknown[];
    };
    expect(body).toEqual({ posts: [], personas: [], hashtags: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns empty envelope when q is < 2 chars (no DB hit)", async () => {
    const res = await callGet("?q=x");
    const body = (await res.json()) as { posts: unknown[] };
    expect(body.posts).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("treats whitespace-only q as empty", async () => {
    const res = await callGet("?q=%20%20%20");
    const body = (await res.json()) as { posts: unknown[] };
    expect(body.posts).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns { posts, personas, hashtags } shape when q is valid", async () => {
    fake.results = [
      [
        {
          id: "p1",
          content: "hello world",
          post_type: "text",
          media_url: null,
          media_type: null,
          like_count: 0,
          ai_like_count: 0,
          created_at: "2026-04-20T00:00:00Z",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
        },
      ],
      [
        {
          id: "persona-1",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
          bio: "",
          persona_type: "general",
          follower_count: 5,
          post_count: 10,
        },
      ],
      [{ tag: "hello", count: 42 }],
    ];
    const res = await callGet("?q=hello");
    const body = (await res.json()) as {
      posts: Array<{ id: string }>;
      personas: Array<{ id: string }>;
      hashtags: Array<{ tag: string; count: number }>;
    };
    expect(Object.keys(body).sort()).toEqual(["hashtags", "personas", "posts"]);
    expect(body.posts[0]?.id).toBe("p1");
    expect(body.personas[0]?.id).toBe("persona-1");
    expect(body.hashtags[0]?.tag).toBe("hello");
  });

  it("issues exactly three parallel queries", async () => {
    fake.results = [[], [], []];
    await callGet("?q=glitch");
    expect(fake.calls).toHaveLength(3);
  });

  it("strips leading # for the hashtag-style match but keeps it in post content search", async () => {
    fake.results = [[], [], []];
    await callGet("?q=%23AIGlitch");
    // posts query uses the raw query (lowercased) for content search
    expect(fake.calls[0]!.values).toContain("%#aiglitch%");
    // personas + hashtags use the stripped, lowercased version
    expect(fake.calls[1]!.values).toContain("%aiglitch%");
    expect(fake.calls[2]!.values).toContain("%aiglitch%");
  });

  it("lowercases the query for case-insensitive LIKE", async () => {
    fake.results = [[], [], []];
    await callGet("?q=AIGlitch");
    for (const call of fake.calls) {
      const hasLowerTerm = call.values.some(
        (v) => typeof v === "string" && v === "%aiglitch%",
      );
      expect(hasLowerTerm).toBe(true);
    }
  });

  it("posts query limits to 20 and excludes replies", async () => {
    fake.results = [[], [], []];
    await callGet("?q=glitch");
    const sqlText = fake.calls[0]!.strings.join("?");
    expect(sqlText).toContain("is_reply_to IS NULL");
    expect(fake.calls[0]!.values).toContain(20);
  });

  it("personas query limits to 10 and filters to active personas", async () => {
    fake.results = [[], [], []];
    await callGet("?q=glitch");
    const sqlText = fake.calls[1]!.strings.join("?");
    expect(sqlText).toContain("is_active = TRUE");
    expect(fake.calls[1]!.values).toContain(10);
  });

  it("hashtags query limits to 10 and groups by tag", async () => {
    fake.results = [[], [], []];
    await callGet("?q=glitch");
    const sqlText = fake.calls[2]!.strings.join("?");
    expect(sqlText).toContain("FROM post_hashtags");
    expect(sqlText).toContain("GROUP BY tag");
    expect(fake.calls[2]!.values).toContain(10);
  });

  it("Cache-Control is public s-maxage=60 SWR=300 when no session_id (non-personalised)", async () => {
    fake.results = [[], [], []];
    const res = await callGet("?q=glitch");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("B5: Cache-Control flips to private, no-store when session_id present", async () => {
    fake.results = [[], [], []];
    const res = await callGet("?q=glitch&session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("B5: no liked lookup when session_id absent (3 calls only)", async () => {
    fake.results = [
      [
        {
          id: "p1",
          content: "hello",
          post_type: "text",
          media_url: null,
          media_type: null,
          like_count: 0,
          ai_like_count: 0,
          created_at: "2026-04-20T00:00:00Z",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
        },
      ],
      [],
      [],
    ];
    const res = await callGet("?q=hello");
    const body = (await res.json()) as {
      posts: Array<{ id: string; liked?: boolean }>;
    };
    expect(fake.calls).toHaveLength(3);
    expect(body.posts[0]?.liked).toBeUndefined();
  });

  it("B5: session_id present attaches liked=true/false per post via human_likes lookup", async () => {
    fake.results = [
      [
        {
          id: "p1",
          content: "hello",
          post_type: "text",
          media_url: null,
          media_type: null,
          like_count: 0,
          ai_like_count: 0,
          created_at: "2026-04-20T00:00:00Z",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
        },
        {
          id: "p2",
          content: "world",
          post_type: "text",
          media_url: null,
          media_type: null,
          like_count: 0,
          ai_like_count: 0,
          created_at: "2026-04-20T00:00:00Z",
          username: "bob",
          display_name: "Bob",
          avatar_emoji: "🤖",
          avatar_url: null,
        },
      ],
      [],
      [],
      [{ post_id: "p1" }], // liked lookup — session liked p1 only
    ];
    const res = await callGet("?q=hello&session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ id: string; liked: boolean }>;
    };
    expect(fake.calls).toHaveLength(4);
    expect(body.posts.find((p) => p.id === "p1")?.liked).toBe(true);
    expect(body.posts.find((p) => p.id === "p2")?.liked).toBe(false);
    const likedSql = fake.calls[3]!.strings.join("?");
    expect(likedSql).toContain("human_likes");
    expect(fake.calls[3]!.values).toContain("user-1");
  });

  it("B5: empty posts list skips the liked lookup entirely", async () => {
    fake.results = [[], [], []]; // no posts matched
    await callGet("?q=nonexistent&session_id=user-1");
    // Only the three search queries fire — no liked lookup when posts.length === 0
    expect(fake.calls).toHaveLength(3);
  });

  it("500 with detail on DB error", async () => {
    fake.throwOnNextCall = new Error("db down");
    const res = await callGet("?q=glitch");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to search");
    expect(body.detail).toBe("db down");
  });
});
