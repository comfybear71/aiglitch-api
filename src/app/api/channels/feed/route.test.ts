/**
 * Integration tests for GET /api/channels/feed.
 *
 * - 400 when slug missing
 * - 404 when channel not found
 * - Returns channel + empty posts when no posts match
 * - Default chronological query with video-only + channel_id filter
 * - Studios channel skips the director-scene exclusion
 * - cursor mode filters by created_at <
 * - shuffle mode uses md5(id || seed) ORDER BY
 * - Posts carry threaded comments + bookmarked + liked + reactions + socialLinks
 * - reactionCounts default all four emojis at 0 when table missing
 * - nextCursor populated only when posts.length === limit AND not shuffle
 * - nextOffset populated only on shuffle with posts.length === limit
 * - Cache-Control: public, s-maxage=30, SWR=120
 * - 500 wrapping on channel-lookup DB error
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
  const req = new NextRequest(`http://localhost/api/channels/feed${query}`);
  return GET(req);
}

function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch-fail-army",
    name: "Fail Army",
    slug: "fail-army",
    emoji: "💥",
    description: "Fails on fails",
    content_rules: null,
    schedule: null,
    subscriber_count: 42,
    genre: "comedy",
    ...overrides,
  };
}

function postRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    persona_id: "glitch-042",
    content: "hi",
    post_type: "text",
    media_url: "https://cdn/x.mp4",
    media_type: "video",
    media_source: null,
    hashtags: null,
    like_count: 0,
    ai_like_count: 0,
    comment_count: 0,
    share_count: 0,
    created_at: "2026-04-20T00:00:00Z",
    channel_id: "ch-fail-army",
    username: "alice",
    display_name: "Alice",
    avatar_emoji: "🤖",
    avatar_url: null,
    persona_type: "general",
    persona_bio: "",
    ...overrides,
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/channels/feed", () => {
  it("400 when slug missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slug is required");
  });

  it("404 when channel lookup returns nothing", async () => {
    fake.results = [[]];
    const res = await callGet("?slug=ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Channel not found");
  });

  it("returns channel + empty posts when no posts match", async () => {
    fake.results = [
      [channel()],
      [], // posts
      [], // subscription lookup (no session)
      [], // personas roster
    ];
    const res = await callGet("?slug=fail-army");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channel: { slug: string; subscribed: boolean };
      personas: unknown[];
      posts: unknown[];
      nextCursor: string | null;
      nextOffset: number | null;
    };
    expect(body.channel.slug).toBe("fail-army");
    expect(body.channel.subscribed).toBe(false);
    expect(body.posts).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.nextOffset).toBeNull();
  });

  it("default mode issues chronological DESC video query with channel filter", async () => {
    fake.results = [
      [channel()],
      [], // posts
      [],
      [],
    ];
    await callGet("?slug=fail-army");
    const postsSql = sqlOf(fake.calls[1]!);
    expect(postsSql).toContain("WHERE p.is_reply_to IS NULL");
    expect(postsSql).toContain("p.channel_id =");
    expect(postsSql).toContain("p.media_type = 'video'");
    expect(postsSql).toContain("ORDER BY p.created_at DESC");
    // Non-studios: excludes director scenes
    expect(postsSql).toContain("director-premiere");
  });

  it("studios channel SKIPS the director-scene exclusion", async () => {
    fake.results = [
      [channel({ id: "ch-aiglitch-studios", slug: "studios" })],
      [],
      [],
      [],
    ];
    await callGet("?slug=studios");
    const postsSql = sqlOf(fake.calls[1]!);
    expect(postsSql).not.toContain("director-premiere");
    expect(postsSql).toContain("p.media_type = 'video'");
  });

  it("cursor mode filters by created_at <", async () => {
    fake.results = [[channel()], [], [], []];
    await callGet("?slug=fail-army&cursor=2026-04-18T00:00:00Z");
    const postsSql = sqlOf(fake.calls[1]!);
    expect(postsSql).toContain("p.created_at < ");
    expect(fake.calls[1]!.values).toContain("2026-04-18T00:00:00Z");
  });

  it("shuffle mode uses md5(id || seed) ordering and passes seed + offset", async () => {
    fake.results = [[channel()], [], [], []];
    await callGet("?slug=fail-army&shuffle=1&seed=abc&offset=40");
    const postsSql = sqlOf(fake.calls[1]!);
    expect(postsSql).toContain("md5(p.id::text || ");
    expect(fake.calls[1]!.values).toContain("abc");
    expect(fake.calls[1]!.values).toContain(40);
  });

  it("posts carry threaded comments + bookmarked + liked + reactions + socialLinks", async () => {
    // Promise.all within the enrichment block kicks off each child promise
    // synchronously. Order of SQL calls:
    //   c.3: getAiComments
    //   c.4: getHumanComments
    //   c.5: getBookmarkedSet
    //   c.6: getLikedSet
    //   c.7: getBatchReactions — counts (first await)
    //   c.8: marketing_posts socialLinks (single await)
    //   c.9: getBatchReactions — user reactions (second await, after c.7 resolves)
    fake.results = [
      [channel()],
      [postRow("p1")], // posts
      [], // c.3 getAiComments
      [], // c.4 getHumanComments
      [{ post_id: "p1" }], // c.5 bookmarked set
      [{ post_id: "p1" }], // c.6 liked set
      [
        // c.7 batch reactions counts
        { post_id: "p1", emoji: "funny", count: 3 },
        { post_id: "p1", emoji: "sad", count: 1 },
      ],
      [
        { source_post_id: "p1", platform: "twitter", platform_url: "https://x.com/a/status/1" },
      ], // c.8 socialLinks
      [{ post_id: "p1", emoji: "funny" }], // c.9 user's own reactions
      [], // subscription
      [], // personas
    ];
    const res = await callGet("?slug=fail-army&session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{
        id: string;
        comments: unknown[];
        bookmarked: boolean;
        liked: boolean;
        reactionCounts: Record<string, number>;
        userReactions: string[];
        socialLinks: Record<string, string>;
      }>;
    };
    const p = body.posts[0]!;
    expect(p.id).toBe("p1");
    expect(p.bookmarked).toBe(true);
    expect(p.liked).toBe(true);
    expect(p.reactionCounts.funny).toBe(3);
    expect(p.reactionCounts.sad).toBe(1);
    expect(p.reactionCounts.shocked).toBe(0); // default
    expect(p.reactionCounts.crap).toBe(0);
    expect(p.userReactions).toEqual(["funny"]);
    expect(p.socialLinks.twitter).toBe("https://x.com/a/status/1");
  });

  it("reactionCounts default all four emojis at 0 when emoji_reactions table missing", async () => {
    fake.results = [
      [channel()],
      [postRow("p1")],
      [],
      [],
      [], // bookmarked
      [], // liked
      // batch reactions swallows DB error internally — we can simulate by
      // providing empty count + user rows (same observable output).
      [], // counts
      [], // user reactions
      [], // social links
      [],
      [],
    ];
    const res = await callGet("?slug=fail-army&session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ reactionCounts: Record<string, number> }>;
    };
    expect(body.posts[0]?.reactionCounts).toEqual({
      funny: 0,
      sad: 0,
      shocked: 0,
      crap: 0,
    });
  });

  it("nextCursor populated only when chronological + posts.length === limit", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      postRow(`p${i}`, { created_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    fake.results = [
      [channel()],
      rows,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ];
    const res = await callGet("?slug=fail-army&limit=20");
    const body = (await res.json()) as { nextCursor: string | null };
    // last row's created_at
    expect(body.nextCursor).toBe(rows[rows.length - 1]?.created_at);
  });

  it("nextOffset populated only on shuffle when posts.length === limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => postRow(`p${i}`));
    fake.results = [
      [channel()],
      rows,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ];
    const res = await callGet("?slug=fail-army&shuffle=1&seed=x&limit=5&offset=10");
    const body = (await res.json()) as {
      nextCursor: string | null;
      nextOffset: number | null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.nextOffset).toBe(15);
  });

  it("Cache-Control is public, s-maxage=30, SWR=120", async () => {
    fake.results = [[channel()], [], [], []];
    const res = await callGet("?slug=fail-army");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("500 wrapping on channel-lookup DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("?slug=fail-army");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to fetch channel feed");
  });
});
