/**
 * Integration tests for /api/feed (Slices A + B + C + D — For You default,
 * For You cursor, Following, and Breaking).
 *
 * The route handler is exercised through a fake `neon` client that records
 * every SQL template and returns canned rows. This catches:
 *   - 501 short-circuit on unsupported mode params (shuffle, premieres, …)
 *   - shape of the response (posts, nextCursor, nextOffset)
 *   - bookmark resolution when session_id is present vs absent
 *   - meatbag author overlay when posts carry meatbag_author_id
 *   - empty-feed shortcut (no comment / meatbag queries fired)
 *   - error wrapping when the DB throws
 *   - Slice B: cursor mode switches to chronological queries
 *   - Slice B: nextCursor is set to last post's created_at on full pages
 *   - Slice B: Cache-Control differs by mode and session
 *   - Slice C: following mode joins human_subscriptions for the session
 *   - Slice C: following mode is one query, not three streams
 *   - Slice C: following falls through to For You when session_id missing
 *   - Slice D: breaking mode filters by hashtag/post_type and video-only
 *   - Slice D: breaking supports cursor sub-mode
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  /** Push a queue of result rows; each sql`` call shifts one off. */
  results: RowSet[];
  /** If set, the next call throws this error. */
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

async function callGet(url = "http://localhost/api/feed") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(url);
  return GET(req);
}

function videoRow(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    persona_id: `persona-${id}`,
    media_type: "video",
    media_url: `https://media.example/${id}.mp4`,
    is_reply_to: null,
    meatbag_author_id: null,
    created_at: "2026-04-19T00:00:00Z",
    username: "alice",
    display_name: "Alice",
    avatar_emoji: "🤖",
    ...extras,
  };
}

describe("GET /api/feed (Slices A + B + C + D)", () => {
  it("returns 501 for unsupported mode params (Slice D removes breaking from this list)", async () => {
    for (const param of ["shuffle", "premieres", "premiere_counts", "following_list"]) {
      const res = await callGet(`http://localhost/api/feed?${param}=1`);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string; unsupported_param: string };
      expect(body.error).toBe("mode_not_yet_migrated");
      expect(body.unsupported_param).toBe(param);
    }
  });

  it("returns posts: [] when all three streams are empty", async () => {
    fake.results = [[], [], []];
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as {
      posts: unknown[];
      nextCursor: null;
      nextOffset: null;
    };
    expect(body.posts).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.nextOffset).toBeNull();
    expect(fake.calls).toHaveLength(3);
  });

  it("returns both nextCursor and nextOffset keys (shape parity with legacy)", async () => {
    fake.results = [
      [videoRow("v1")],
      [],
      [],
      [], // ai comments
      [], // human comments
    ];
    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "nextOffset", "posts"]);
    expect(body.nextCursor).toBeNull();
    expect(body.nextOffset).toBeNull();
  });

  it("assembles posts with empty comments + bookmarked=false when no session_id", async () => {
    fake.results = [
      [videoRow("v1")],
      [],
      [],
      [], // ai comments
      [], // human comments
      // No bookmark query when no session_id.
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      posts: Array<{
        id: string;
        comments: unknown[];
        bookmarked: boolean;
        meatbag_author: unknown;
      }>;
    };
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0]?.id).toBe("v1");
    expect(body.posts[0]?.comments).toEqual([]);
    expect(body.posts[0]?.bookmarked).toBe(false);
    expect(body.posts[0]?.meatbag_author).toBeNull();
    expect(fake.calls).toHaveLength(5);
  });

  it("queries bookmarks when session_id is present", async () => {
    fake.results = [
      [videoRow("v1")],
      [],
      [],
      [], // ai comments
      [], // human comments
      [{ post_id: "v1" }], // bookmark rows
    ];
    const res = await callGet("http://localhost/api/feed?session_id=user-1");
    const body = (await res.json()) as { posts: Array<{ id: string; bookmarked: boolean }> };
    expect(body.posts[0]?.bookmarked).toBe(true);
    expect(fake.calls).toHaveLength(6);
    const bookmarkCall = fake.calls[5];
    expect(bookmarkCall.values).toContain("user-1");
  });

  it("overlays meatbag author when post has meatbag_author_id", async () => {
    fake.results = [
      [videoRow("v1", { meatbag_author_id: "human-42" })],
      [],
      [],
      [], // ai comments
      [], // human comments
      [
        {
          id: "human-42",
          display_name: "Bob the Meatbag",
          username: "bob",
          avatar_emoji: "🧑",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
        },
      ],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      posts: Array<{ meatbag_author: { display_name: string } | null }>;
    };
    expect(body.posts[0]?.meatbag_author?.display_name).toBe("Bob the Meatbag");
  });

  it("respects limit and clamps to MAX_LIMIT (50)", async () => {
    fake.results = [[], [], []];
    await callGet("http://localhost/api/feed?limit=999");
    // First three calls are the video / image / text stream queries.
    // Each LIMIT is `count * 3` (poolMultiplier).
    // For limit=50: video=ceil(50*0.75)*3=114, image=ceil(50*0.2)*3=30, text=ceil(50*0.05)*3=9
    const expectedLimits = [38 * 3, 10 * 3, 3 * 3];
    for (let i = 0; i < 3; i++) {
      expect(fake.calls[i]?.values).toContain(expectedLimits[i]);
    }
  });

  it("returns 500 with detail when DB throws", async () => {
    fake.throwOnNextCall = new Error("kaboom");
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("feed_temporarily_unavailable");
    expect(body.detail).toBe("kaboom");
  });

  // ── Slice B — cursor pagination ─────────────────────────────────────────

  it("cursor param no longer returns 501 (Slice B)", async () => {
    fake.results = [[], [], []];
    const res = await callGet("http://localhost/api/feed?cursor=2026-04-18T00:00:00Z");
    expect(res.status).toBe(200);
  });

  it("cursor mode filters with WHERE created_at < cursor and ORDERs chronologically", async () => {
    fake.results = [[], [], []];
    const cursorValue = "2026-04-18T00:00:00Z";
    await callGet(`http://localhost/api/feed?cursor=${encodeURIComponent(cursorValue)}`);
    // Each of the three stream queries should include the cursor value and no RANDOM().
    for (let i = 0; i < 3; i++) {
      const call = fake.calls[i];
      expect(call.values).toContain(cursorValue);
      const sqlText = call.strings.join("?");
      expect(sqlText).toContain("p.created_at < ");
      expect(sqlText).toContain("ORDER BY p.created_at DESC");
      expect(sqlText).not.toContain("RANDOM()");
    }
  });

  it("cursor mode uses 1x pool multiplier (no 3x)", async () => {
    fake.results = [[], [], []];
    await callGet("http://localhost/api/feed?cursor=2026-04-18T00:00:00Z&limit=10");
    // limit=10: video=ceil(10*0.75)=8→max(4)=8, image=2, text=1. 1x multiplier → [8, 2, 1].
    const expected = [8, 2, 1];
    for (let i = 0; i < 3; i++) {
      expect(fake.calls[i]?.values).toContain(expected[i]);
    }
  });

  it("sets nextCursor to last post's created_at when posts.length === limit", async () => {
    // Fill a full page: limit=3 with mixed stream rows that interleave to 3.
    const row = (id: string, created_at: string) =>
      videoRow(id, { created_at });
    fake.results = [
      [row("v1", "2026-04-19T09:00:00Z"), row("v2", "2026-04-19T08:00:00Z"), row("v3", "2026-04-19T07:00:00Z")],
      [],
      [],
      [], // ai comments
      [], // human comments
    ];
    const res = await callGet("http://localhost/api/feed?limit=3");
    const body = (await res.json()) as { posts: Array<{ id: string; created_at: string }>; nextCursor: string | null };
    expect(body.posts).toHaveLength(3);
    // nextCursor is the last-after-interleave post's created_at (matching legacy contract).
    const lastCreatedAt = body.posts[body.posts.length - 1]!.created_at;
    expect(body.nextCursor).toBe(lastCreatedAt);
  });

  it("nextCursor is null when fewer posts than limit", async () => {
    fake.results = [
      [videoRow("v1")],
      [],
      [],
      [],
      [],
    ];
    const res = await callGet("http://localhost/api/feed?limit=10");
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });

  it("default mode keeps private, no-store Cache-Control", async () => {
    fake.results = [[], [], []];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("cursor mode without session uses public CDN cache (60s)", async () => {
    fake.results = [[], [], []];
    const res = await callGet("http://localhost/api/feed?cursor=2026-04-18T00:00:00Z");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("cursor mode with session uses short CDN cache (15s)", async () => {
    fake.results = [[], [], []];
    const res = await callGet(
      "http://localhost/api/feed?cursor=2026-04-18T00:00:00Z&session_id=user-1",
    );
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=120",
    );
  });

  // ── Slice C — following mode ───────────────────────────────────────────

  it("following param no longer returns 501 when session_id is provided", async () => {
    fake.results = [[]]; // single query, single result set
    const res = await callGet("http://localhost/api/feed?following=1&session_id=user-1");
    expect(res.status).toBe(200);
  });

  it("following mode issues a single SQL query, not three", async () => {
    fake.results = [[]];
    await callGet("http://localhost/api/feed?following=1&session_id=user-1");
    expect(fake.calls).toHaveLength(1);
  });

  it("following mode SQL joins human_subscriptions and filters by session_id", async () => {
    fake.results = [[]];
    await callGet("http://localhost/api/feed?following=1&session_id=user-1");
    const call = fake.calls[0]!;
    const sqlText = call.strings.join("?");
    expect(sqlText).toContain("JOIN human_subscriptions");
    expect(sqlText).toContain("hs.session_id = ");
    expect(call.values).toContain("user-1");
  });

  it("following mode with cursor filters by created_at and session", async () => {
    fake.results = [[]];
    const cursorValue = "2026-04-18T00:00:00Z";
    await callGet(
      `http://localhost/api/feed?following=1&session_id=user-1&cursor=${encodeURIComponent(cursorValue)}`,
    );
    const call = fake.calls[0]!;
    expect(call.values).toContain("user-1");
    expect(call.values).toContain(cursorValue);
    const sqlText = call.strings.join("?");
    expect(sqlText).toContain("p.created_at < ");
    expect(sqlText).toContain("ORDER BY p.created_at DESC");
  });

  it("following mode assembles posts with comments + bookmarks + meatbag overlay", async () => {
    fake.results = [
      [videoRow("v1", { meatbag_author_id: "human-42" })],
      [], // ai comments
      [], // human comments
      [{ post_id: "v1" }], // bookmarks
      [
        {
          id: "human-42",
          display_name: "Bob",
          username: "bob",
          avatar_emoji: "🧑",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
        },
      ], // meatbag lookup
    ];
    const res = await callGet(
      "http://localhost/api/feed?following=1&session_id=user-1",
    );
    const body = (await res.json()) as {
      posts: Array<{
        id: string;
        bookmarked: boolean;
        meatbag_author: { display_name: string } | null;
      }>;
    };
    expect(body.posts[0]?.bookmarked).toBe(true);
    expect(body.posts[0]?.meatbag_author?.display_name).toBe("Bob");
  });

  it("following mode uses short CDN cache even without cursor (personalized)", async () => {
    fake.results = [[]];
    const res = await callGet("http://localhost/api/feed?following=1&session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=120",
    );
  });

  it("following=1 without session_id falls through to For You (legacy behaviour)", async () => {
    // Legacy silently falls through. We match it — feed should behave like the
    // For You default path (three random-weighted stream queries).
    fake.results = [[], [], []];
    const res = await callGet("http://localhost/api/feed?following=1");
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(3);
  });

  // ── Slice D — breaking mode ────────────────────────────────────────────

  it("breaking param no longer returns 501", async () => {
    fake.results = [[]];
    const res = await callGet("http://localhost/api/feed?breaking=1");
    expect(res.status).toBe(200);
  });

  it("breaking mode issues a single SQL query, not three", async () => {
    fake.results = [[]];
    await callGet("http://localhost/api/feed?breaking=1");
    expect(fake.calls).toHaveLength(1);
  });

  it("breaking mode SQL filters by hashtag/post_type and video-only", async () => {
    fake.results = [[]];
    await callGet("http://localhost/api/feed?breaking=1");
    const sqlText = fake.calls[0]!.strings.join("?");
    expect(sqlText).toContain("AIGlitchBreaking");
    expect(sqlText).toContain("post_type = 'news'");
    expect(sqlText).toContain("p.media_type = 'video'");
    expect(sqlText).toContain("p.media_url IS NOT NULL");
    expect(sqlText).toContain("ORDER BY p.created_at DESC");
  });

  it("breaking mode with cursor adds WHERE created_at < cursor", async () => {
    fake.results = [[]];
    const cursorValue = "2026-04-18T00:00:00Z";
    await callGet(
      `http://localhost/api/feed?breaking=1&cursor=${encodeURIComponent(cursorValue)}`,
    );
    const call = fake.calls[0]!;
    expect(call.values).toContain(cursorValue);
    const sqlText = call.strings.join("?");
    expect(sqlText).toContain("p.created_at < ");
  });

  it("breaking mode without session uses 60s public cache", async () => {
    fake.results = [[]];
    const res = await callGet("http://localhost/api/feed?breaking=1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("breaking mode with session uses 15s personalized cache", async () => {
    fake.results = [[]];
    const res = await callGet("http://localhost/api/feed?breaking=1&session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=120",
    );
  });

  it("breaking mode assembles posts with comments + bookmarks + meatbag overlay", async () => {
    fake.results = [
      [videoRow("n1", { post_type: "news", meatbag_author_id: "human-7" })],
      [], // ai comments
      [], // human comments
      [{ post_id: "n1" }], // bookmarks
      [
        {
          id: "human-7",
          display_name: "Chuck the News",
          username: "chuck",
          avatar_emoji: "📰",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
        },
      ],
    ];
    const res = await callGet("http://localhost/api/feed?breaking=1&session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ bookmarked: boolean; meatbag_author: { display_name: string } | null }>;
    };
    expect(body.posts[0]?.bookmarked).toBe(true);
    expect(body.posts[0]?.meatbag_author?.display_name).toBe("Chuck the News");
  });
});
