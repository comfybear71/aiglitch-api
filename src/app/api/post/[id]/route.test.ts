/**
 * Integration tests for /api/post/[id] (single-post endpoint).
 *
 * Catches:
 *   - 404 when post doesn't exist
 *   - 200 with wrapped { post } shape when it does
 *   - comments threaded correctly for the one post
 *   - bookmarked flips on session_id presence
 *   - meatbag_author overlay when post has meatbag_author_id
 *   - Cache-Control differs by session presence
 *   - 500 wrapping when the DB throws
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

async function callGet(postId: string, queryString = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const url = `http://localhost/api/post/${postId}${queryString}`;
  const req = new NextRequest(url);
  return GET(req, { params: Promise.resolve({ id: postId }) });
}

function postRow(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    persona_id: `persona-${id}`,
    content: "hello",
    post_type: "text",
    media_url: null,
    media_type: null,
    media_source: null,
    hashtags: null,
    like_count: 0,
    ai_like_count: 0,
    comment_count: 0,
    share_count: 0,
    created_at: "2026-04-19T00:00:00Z",
    is_reply_to: null,
    meatbag_author_id: null,
    username: "alice",
    display_name: "Alice",
    avatar_emoji: "🤖",
    avatar_url: null,
    persona_type: "general",
    persona_bio: "",
    ...extras,
  };
}

describe("GET /api/post/[id]", () => {
  it("returns 404 when post not found", async () => {
    fake.results = [[]]; // getPostById returns empty
    const res = await callGet("missing-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Post not found");
  });

  it("returns 200 with { post } wrapped shape when found", async () => {
    fake.results = [
      [postRow("p1")], // getPostById
      [], // aiComments
      [], // humanComments
      // no bookmark query (no session_id)
    ];
    const res = await callGet("p1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["post"]);
    const post = body.post as Record<string, unknown>;
    expect(post.id).toBe("p1");
    expect(post.comments).toEqual([]);
    expect(post.bookmarked).toBe(false);
    expect(post.meatbag_author).toBeNull();
  });

  it("threads comments into the post", async () => {
    fake.results = [
      [postRow("p1")], // getPostById
      [
        {
          id: "ai-1",
          content: "ai hello",
          created_at: "2026-04-19T00:00:01Z",
          like_count: 0,
          post_id: "p1",
          parent_comment_id: null,
          parent_comment_type: null,
          username: "bob",
          display_name: "Bob",
          avatar_emoji: "🤖",
          avatar_url: null,
          is_human: false,
        },
      ], // aiComments
      [
        {
          id: "h-1",
          content: "human hi",
          created_at: "2026-04-19T00:00:02Z",
          like_count: 0,
          post_id: "p1",
          parent_comment_id: null,
          parent_comment_type: null,
          username: "human",
          display_name: "Stu",
          avatar_emoji: "🧑",
          is_human: true,
        },
      ], // humanComments
    ];
    const res = await callGet("p1");
    const body = (await res.json()) as { post: { comments: Array<{ id: string }> } };
    expect(body.post.comments.map((c) => c.id).sort()).toEqual(["ai-1", "h-1"]);
  });

  it("flips bookmarked to true when session has bookmarked the post", async () => {
    fake.results = [
      [postRow("p1")],
      [],
      [],
      [{ post_id: "p1" }], // bookmark rows
    ];
    const res = await callGet("p1", "?session_id=user-1");
    const body = (await res.json()) as { post: { bookmarked: boolean } };
    expect(body.post.bookmarked).toBe(true);
  });

  it("overlays meatbag_author when post has meatbag_author_id", async () => {
    fake.results = [
      [postRow("p1", { meatbag_author_id: "human-42" })],
      [],
      [],
      [
        {
          id: "human-42",
          display_name: "Stu",
          username: "stu",
          avatar_emoji: "🧑",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
        },
      ], // human_users lookup
    ];
    const res = await callGet("p1");
    const body = (await res.json()) as {
      post: { meatbag_author: { display_name: string } | null };
    };
    expect(body.post.meatbag_author?.display_name).toBe("Stu");
  });

  it("uses 60s public cache without session_id", async () => {
    fake.results = [[postRow("p1")], [], []];
    const res = await callGet("p1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("uses 15s personalized cache with session_id", async () => {
    fake.results = [[postRow("p1")], [], [], []];
    const res = await callGet("p1", "?session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=120",
    );
  });

  it("returns 500 with detail when DB throws", async () => {
    fake.throwOnNextCall = new Error("db down");
    const res = await callGet("p1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to fetch post");
    expect(body.detail).toBe("db down");
  });
});
