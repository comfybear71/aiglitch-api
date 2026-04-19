/**
 * Integration tests for GET /api/likes (user's liked posts, newest-first).
 *
 * Catches:
 *   - 200 with posts: [] when session_id missing (no DB hit)
 *   - 200 with list + flat comments when session_id present
 *   - Each post decorated with { liked: true }
 *   - Cache-Control: public, s-maxage=15, SWR=120
 *   - Comments are flat (not threaded) and sliced to 20
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
  const req = new NextRequest(`http://localhost/api/likes${query}`);
  return GET(req);
}

function postRow(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    persona_id: `persona-${id}`,
    content: "hi",
    post_type: "text",
    created_at: "2026-04-19T00:00:00Z",
    username: "alice",
    display_name: "Alice",
    avatar_emoji: "🤖",
    persona_type: "general",
    persona_bio: "",
    ...extras,
  };
}

function commentRow(id: string, post_id: string, created_at: string) {
  return {
    id,
    post_id,
    content: "c",
    created_at,
    like_count: 0,
    parent_comment_id: null,
    parent_comment_type: null,
    username: "u",
    display_name: "U",
    avatar_emoji: "👤",
    avatar_url: null,
    is_human: false,
  };
}

describe("GET /api/likes", () => {
  it("returns empty posts list when session_id missing (no DB hit)", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: unknown[] };
    expect(body.posts).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns 200 with empty list when session has no likes", async () => {
    fake.results = [[]]; // getLikedPosts returns no rows; attachFlatComments skips comment queries
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: unknown[] };
    expect(body.posts).toEqual([]);
    // Only the getLikedPosts query — comments skipped on empty postIds.
    expect(fake.calls).toHaveLength(1);
  });

  it("returns posts list decorated with { liked: true }", async () => {
    fake.results = [
      [postRow("p1"), postRow("p2")], // getLikedPosts
      [], // getAiComments
      [], // getHumanComments
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ id: string; liked: boolean; comments: unknown[] }>;
    };
    expect(body.posts.map((p) => p.id)).toEqual(["p1", "p2"]);
    for (const p of body.posts) {
      expect(p.liked).toBe(true);
      expect(p.comments).toEqual([]);
    }
  });

  it("sorts comments chronologically asc and slices to 20", async () => {
    const manyComments = Array.from({ length: 50 }, (_, i) =>
      commentRow(
        `c-${i}`,
        "p1",
        `2026-04-19T00:00:${String(i).padStart(2, "0")}Z`,
      ),
    );
    fake.results = [
      [postRow("p1")],
      manyComments.slice(0, 30), // AI comments: 30
      manyComments.slice(30, 50), // human comments: 20
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ comments: Array<{ id: string; created_at: string }> }>;
    };
    expect(body.posts[0]!.comments).toHaveLength(20);
    // First is earliest; last is earlier than anything dropped.
    const timestamps = body.posts[0]!.comments.map((c) =>
      new Date(c.created_at).getTime(),
    );
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });

  it("SELECT joins human_likes and orders by hl.created_at DESC", async () => {
    fake.results = [[]];
    await callGet("?session_id=user-1");
    const sqlText = fake.calls[0]!.strings.join("?");
    expect(sqlText).toContain("FROM human_likes");
    expect(sqlText).toContain("ORDER BY hl.created_at DESC");
    expect(fake.calls[0]!.values).toContain("user-1");
  });

  it("Cache-Control is private, no-store (session-personalised — Vercel edge must NOT cache)", async () => {
    fake.results = [[]];
    const res = await callGet("?session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("500 on DB error", async () => {
    fake.throwOnNextCall = new Error("neon down");
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to fetch liked posts");
    expect(body.detail).toBe("neon down");
  });
});
