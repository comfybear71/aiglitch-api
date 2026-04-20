/**
 * Integration tests for GET /api/bookmarks (user's bookmarked posts).
 * Mirrors /api/likes — same structure, just `bookmarked: true` overlay and
 * the `human_bookmarks` join.
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
  const req = new NextRequest(`http://localhost/api/bookmarks${query}`);
  return GET(req);
}

function postRow(id: string) {
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
  };
}

describe("GET /api/bookmarks", () => {
  it("returns empty posts when session_id missing", async () => {
    const res = await callGet();
    const body = (await res.json()) as { posts: unknown[] };
    expect(body.posts).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns list decorated with { bookmarked: true } and per-session liked", async () => {
    fake.results = [
      [postRow("p1")],
      [], // ai comments
      [], // human comments
      [], // liked lookup — not liked
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ id: string; bookmarked: boolean; liked: boolean }>;
    };
    expect(body.posts[0]!.bookmarked).toBe(true);
    expect(body.posts[0]!.liked).toBe(false);
    expect(body.posts[0]!.id).toBe("p1");
  });

  it("B4: liked=true when the bookmarked post is also in human_likes for this session", async () => {
    fake.results = [
      [postRow("p1")],
      [],
      [],
      [{ post_id: "p1" }], // liked lookup — session liked it too
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ liked: boolean; bookmarked: boolean }>;
    };
    expect(body.posts[0]!.liked).toBe(true);
    expect(body.posts[0]!.bookmarked).toBe(true);
    // 4 calls: bookmarks + ai comments + human comments + liked lookup
    expect(fake.calls).toHaveLength(4);
    const likedSql = fake.calls[3]!.strings.join("?");
    expect(likedSql).toContain("human_likes");
    expect(fake.calls[3]!.values).toContain("user-1");
  });

  it("SELECT joins human_bookmarks and orders by hb.created_at DESC", async () => {
    fake.results = [[]];
    await callGet("?session_id=user-1");
    const sqlText = fake.calls[0]!.strings.join("?");
    expect(sqlText).toContain("FROM human_bookmarks");
    expect(sqlText).toContain("ORDER BY hb.created_at DESC");
  });

  it("Cache-Control is private, no-store (session-personalised — Vercel edge must NOT cache)", async () => {
    fake.results = [[]];
    const res = await callGet("?session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("500 on DB error", async () => {
    fake.throwOnNextCall = new Error("kaboom");
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(500);
  });
});
