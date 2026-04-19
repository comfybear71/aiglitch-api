/**
 * Integration tests for /api/feed (Slice A — For You default mode).
 *
 * The route handler is exercised through a fake `neon` client that records
 * every SQL template and returns canned rows. This catches:
 *   - 501 short-circuit on unsupported mode params
 *   - shape of the response (posts, nextCursor)
 *   - bookmark resolution when session_id is present vs absent
 *   - meatbag author overlay when posts carry meatbag_author_id
 *   - empty-feed shortcut (no comment / meatbag queries fired)
 *   - error wrapping when the DB throws
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

describe("GET /api/feed (Slice A)", () => {
  it("returns 501 for unsupported mode params", async () => {
    for (const param of ["cursor", "shuffle", "following", "breaking", "premieres", "premiere_counts", "following_list"]) {
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
    const body = (await res.json()) as { posts: unknown[]; nextCursor: null };
    expect(body.posts).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(fake.calls).toHaveLength(3);
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
});
