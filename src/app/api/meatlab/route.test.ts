/**
 * Integration tests for GET /api/meatlab.
 *
 * Three GET modes:
 *   - ?approved=1               → public gallery of approved posts
 *   - ?creator=<slug>           → creator profile + posts + stats + feedPosts (w/ comments + liked + bookmarked — B6)
 *   - default (with session_id) → user's own submissions (all statuses)
 *
 * POST + PATCH return 501 method_not_yet_migrated (deferred).
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
  const req = new NextRequest(`http://localhost/api/meatlab${query}`);
  return GET(req);
}

function creatorRow() {
  return {
    id: "user-42",
    display_name: "Stu",
    username: "stu",
    avatar_emoji: "🧑",
    avatar_url: null,
    bio: "",
    x_handle: null,
    instagram_handle: null,
    tiktok_handle: null,
    youtube_handle: null,
    website_url: null,
    created_at: "2026-04-20T00:00:00Z",
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/meatlab", () => {
  it("401 when no session_id, no creator, no approved", async () => {
    const res = await callGet();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session_id required");
    expect(fake.calls).toHaveLength(0);
  });

  it("default mode returns user's own submissions when session_id present", async () => {
    fake.results = [[{ id: "s-1", status: "pending" }]];
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      posts: Array<{ id: string; status: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.posts[0]?.id).toBe("s-1");
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("FROM meatlab_submissions");
    expect(sql).toContain("WHERE session_id = ");
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  it("?approved=1 returns public gallery with creator join", async () => {
    fake.results = [
      [
        {
          id: "s-1",
          status: "approved",
          creator_name: "Stu",
          creator_username: "stu",
        },
      ],
    ];
    const res = await callGet("?approved=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      posts: Array<{ creator_username: string }>;
    };
    expect(body.posts[0]?.creator_username).toBe("stu");
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("LEFT JOIN human_users h");
    expect(sql).toContain("WHERE m.status = 'approved'");
  });

  it("?approved=1 response is public cache (30s) when no session_id", async () => {
    fake.results = [[]];
    const res = await callGet("?approved=1");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );
  });

  it("?approved=1 with session_id becomes private, no-store", async () => {
    fake.results = [[]];
    const res = await callGet("?approved=1&session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("?limit clamps to 100", async () => {
    fake.results = [[]];
    await callGet("?approved=1&limit=5000");
    expect(fake.calls[0]!.values).toContain(100);
  });

  it("?limit defaults to 20 when unset", async () => {
    fake.results = [[]];
    await callGet("?approved=1");
    expect(fake.calls[0]!.values).toContain(20);
  });

  it("?creator=<slug> 404 when no user matches", async () => {
    fake.results = [[]]; // findCreator empty
    const res = await callGet("?creator=ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Creator not found");
  });

  it("?creator=<slug> returns creator + posts + stats + feedPosts", async () => {
    fake.results = [
      [creatorRow()], // findCreator
      [{ total_uploads: 3, total_likes: 7, total_comments: 2, total_views: 42 }], // getCreatorStats (posts-table)
      [{ id: "s-1", status: "approved" }, { id: "s-2", status: "approved" }], // listCreatorApprovedSubmissions
      [], // listCreatorFeedPosts (empty — no enrichment queries fire)
    ];
    const res = await callGet("?creator=stu");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      creator: { username: string };
      stats: { total_uploads: number; total_likes: number };
      total: number;
      posts: unknown[];
      feedPosts: unknown[];
    };
    expect(body.creator.username).toBe("stu");
    expect(body.stats.total_uploads).toBe(3);
    expect(body.total).toBe(2);
    expect(body.posts).toHaveLength(2);
    expect(body.feedPosts).toEqual([]);
  });

  it("?creator=<slug> stats falls back to meatlab_submissions count when posts table empty", async () => {
    // Promise.all in the route fires getCreatorStats + listCreatorApprovedSubmissions
    // + listCreatorFeedPosts in parallel, so the first SQL from each lands before
    // getCreatorStats issues its fallback query. Result order matches that fire order.
    fake.results = [
      [creatorRow()], // findCreator
      [{ total_uploads: 0, total_likes: 0, total_comments: 0, total_views: 0 }], // stats posts-table (zero)
      [{ id: "s-1", status: "approved" }], // submissions list
      [], // feedPosts
      [{ total_uploads: 5 }], // stats fallback (meatlab_submissions count)
    ];
    const res = await callGet("?creator=stu");
    const body = (await res.json()) as { stats: { total_uploads: number } };
    expect(body.stats.total_uploads).toBe(5);
  });

  it("B6: feedPosts carry threaded comments + per-session liked + bookmarked", async () => {
    const feedPost = {
      id: "post-abc",
      persona_id: "glitch-000",
      content: "my meatbag upload",
      post_type: "meatlab",
      media_url: "https://cdn/x.mp4",
      media_type: "video",
      media_source: null,
      hashtags: null,
      like_count: 5,
      ai_like_count: 3,
      comment_count: 2,
      share_count: 0,
      created_at: "2026-04-20T01:00:00Z",
      meatbag_author_id: "user-42",
      username: "architect",
      display_name: "The Architect",
      avatar_emoji: "🏗️",
      avatar_url: null,
      persona_type: "admin",
      persona_bio: "",
    };
    fake.results = [
      [creatorRow()], // findCreator
      [{ total_uploads: 1, total_likes: 8, total_comments: 2, total_views: 0 }],
      [], // submissions
      [feedPost], // feedPosts
      // enrichment batch (because feedPosts.length > 0):
      [
        {
          id: "c-1",
          content: "AI comment",
          created_at: "2026-04-20T01:30:00Z",
          like_count: 0,
          post_id: "post-abc",
          parent_comment_id: null,
          parent_comment_type: null,
          username: "ai",
          display_name: "AI",
          avatar_emoji: "🤖",
          avatar_url: null,
          is_human: false,
        },
      ], // getAiComments
      [], // getHumanComments
      [{ post_id: "post-abc" }], // getLikedSet
      [], // getBookmarkedSet
    ];
    const res = await callGet("?creator=stu&session_id=user-1");
    const body = (await res.json()) as {
      feedPosts: Array<{
        id: string;
        comments: Array<{ id: string }>;
        liked: boolean;
        bookmarked: boolean;
      }>;
    };
    expect(body.feedPosts).toHaveLength(1);
    expect(body.feedPosts[0]?.comments).toHaveLength(1);
    expect(body.feedPosts[0]?.comments[0]?.id).toBe("c-1");
    expect(body.feedPosts[0]?.liked).toBe(true);
    expect(body.feedPosts[0]?.bookmarked).toBe(false);
  });

  it("?creator=<slug> lowercases the slug for case-insensitive match", async () => {
    fake.results = [[]]; // findCreator empty
    await callGet("?creator=StU");
    expect(fake.calls[0]!.values).toContain("stu");
  });

  it("500 on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load meatlab");
    expect(body.detail).toBe("pg down");
  });
});

describe("POST + PATCH /api/meatlab (deferred)", () => {
  it("POST returns 501 method_not_yet_migrated", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; method: string };
    expect(body.error).toBe("method_not_yet_migrated");
    expect(body.method).toBe("POST");
  });

  it("PATCH returns 501 method_not_yet_migrated", async () => {
    vi.resetModules();
    const { PATCH } = await import("./route");
    const res = await PATCH();
    expect(res.status).toBe(501);
    const body = (await res.json()) as { method: string };
    expect(body.method).toBe("PATCH");
  });
});
