/**
 * Integration tests for GET /api/profile.
 *
 * Dispatches on the first successful lookup: AI persona by username, else
 * human user by username or id, else 404.
 *
 * Catches:
 *   - 400 on missing username
 *   - Persona branch: full envelope with posts + stats + media + isFollowing
 *   - Persona: isFollowing defaults false when session_id absent
 *   - Persona posts carry per-session `liked` + `bookmarked` flags (B1)
 *   - Meatbag branch: { is_meatbag, meatbag, uploads, stats }
 *   - Meatbag uploads carry threaded comments + `liked` + `bookmarked`
 *     bridged via `feed_post_id` (B2)
 *   - Meatbag uploads with no feed_post_id fall back to empty comments
 *   - 404 when neither persona nor meatbag matches
 *   - Cache-Control: public, s-maxage=30, SWR=300 (no session_id)
 *   - Cache-Control: private, no-store (session_id present — B3)
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
  const req = new NextRequest(`http://localhost/api/profile${query}`);
  return GET(req);
}

function personaRow(id: string, username: string) {
  return {
    id,
    username,
    display_name: "Alice",
    avatar_emoji: "🤖",
    avatar_url: null,
    bio: "",
    persona_type: "general",
    personality: "",
    human_backstory: "",
    follower_count: 0,
    post_count: 0,
    activity_level: 3,
    is_active: true,
    created_at: "2026-04-20T00:00:00Z",
    avatar_updated_at: null,
  };
}

function statsRow() {
  return {
    total_human_likes: 12,
    total_ai_likes: 42,
    total_comments: 5,
  };
}

describe("GET /api/profile", () => {
  it("400 when username missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing username");
  });

  it("404 when neither persona nor meatbag matches", async () => {
    fake.results = [
      [], // getByUsername returns no rows
      [], // meatbag lookup: no rows
    ];
    const res = await callGet("?username=nobody");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Profile not found");
  });

  it("persona branch returns full envelope when lookup succeeds", async () => {
    fake.results = [
      [personaRow("glitch-042", "alice")], // getByUsername
      [], // getByPersona — no posts
      [statsRow()], // getStats
      [], // getMedia
      // Comments batch only fires if there are postIds — skipped here.
    ];
    const res = await callGet("?username=alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona: { id: string };
      posts: unknown[];
      stats: { total_human_likes: number };
      isFollowing: boolean;
      personaMedia: unknown[];
    };
    expect(body.persona.id).toBe("glitch-042");
    expect(body.posts).toEqual([]);
    expect(body.stats.total_human_likes).toBe(12);
    expect(body.isFollowing).toBe(false); // no session_id
    expect(body.personaMedia).toEqual([]);
  });

  it("persona isFollowing reflects session_id when provided", async () => {
    fake.results = [
      [personaRow("glitch-042", "alice")],
      [{ id: "sub-1" }], // isFollowing: human_subscriptions row exists
      [], // getByPersona
      [statsRow()],
      [],
    ];
    const res = await callGet("?username=alice&session_id=user-1");
    const body = (await res.json()) as { isFollowing: boolean };
    expect(body.isFollowing).toBe(true);
  });

  it("persona path fires AI+human comment batch when posts are present", async () => {
    fake.results = [
      [personaRow("glitch-042", "alice")],
      // getByPersona returns one post
      [
        {
          id: "p-1",
          persona_id: "glitch-042",
          content: "hi",
          post_type: "text",
          media_url: null,
          media_type: null,
          media_source: null,
          hashtags: null,
          like_count: 0,
          ai_like_count: 0,
          comment_count: 0,
          share_count: 0,
          created_at: "2026-04-20T00:00:00Z",
          is_reply_to: null,
          channel_id: null,
          meatbag_author_id: null,
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
          persona_type: "general",
          persona_bio: "",
        },
      ],
      [statsRow()],
      [], // getMedia
      [], // getAiComments
      [], // getHumanComments
    ];
    const res = await callGet("?username=alice");
    const body = (await res.json()) as {
      posts: Array<{ id: string; comments: unknown[]; liked: boolean; bookmarked: boolean }>;
    };
    expect(body.posts[0]?.id).toBe("p-1");
    expect(body.posts[0]?.comments).toEqual([]);
    // No session_id → liked/bookmarked queries skip, both default false.
    expect(body.posts[0]?.liked).toBe(false);
    expect(body.posts[0]?.bookmarked).toBe(false);
  });

  it("B1: persona posts carry per-session liked + bookmarked flags", async () => {
    const post = {
      id: "p-1",
      persona_id: "glitch-042",
      content: "hi",
      post_type: "text",
      media_url: null,
      media_type: null,
      media_source: null,
      hashtags: null,
      like_count: 0,
      ai_like_count: 0,
      comment_count: 0,
      share_count: 0,
      created_at: "2026-04-20T00:00:00Z",
      is_reply_to: null,
      channel_id: null,
      meatbag_author_id: null,
      username: "alice",
      display_name: "Alice",
      avatar_emoji: "🤖",
      avatar_url: null,
      persona_type: "general",
      persona_bio: "",
    };
    fake.results = [
      [personaRow("glitch-042", "alice")], // getByUsername
      [{ id: "sub-1" }], // isFollowing lookup
      [post], // getByPersona
      [statsRow()],
      [], // getMedia
      [], // getAiComments
      [], // getHumanComments
      [{ post_id: "p-1" }], // getLikedSet
      [], // getBookmarkedSet (not bookmarked)
    ];
    const res = await callGet("?username=alice&session_id=user-1");
    const body = (await res.json()) as {
      posts: Array<{ liked: boolean; bookmarked: boolean }>;
    };
    expect(body.posts[0]?.liked).toBe(true);
    expect(body.posts[0]?.bookmarked).toBe(false);
  });

  it("meatbag fallback returns is_meatbag envelope when persona lookup fails", async () => {
    fake.results = [
      [], // getByUsername returns no persona
      [
        {
          id: "user-123",
          display_name: "Stuie",
          username: "stuie",
          avatar_emoji: "🧑",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
          tiktok_handle: null,
          youtube_handle: null,
          website_url: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
      [{ id: "up-1", title: "My AI Art", feed_post_id: null }], // uploads (no feed_post_id)
      [{ total_uploads: 1, total_likes: 3, total_comments: 2, total_views: 99 }],
    ];
    const res = await callGet("?username=stuie");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      is_meatbag: boolean;
      meatbag: { username: string };
      uploads: Array<{
        id: string;
        comments: unknown[];
        liked: boolean;
        bookmarked: boolean;
      }>;
      stats: { total_uploads: number };
    };
    expect(body.is_meatbag).toBe(true);
    expect(body.meatbag.username).toBe("stuie");
    expect(body.uploads[0]?.id).toBe("up-1");
    expect(body.uploads[0]?.comments).toEqual([]);
    expect(body.uploads[0]?.liked).toBe(false);
    expect(body.uploads[0]?.bookmarked).toBe(false);
    expect(body.stats.total_uploads).toBe(1);
  });

  it("B2: meatbag uploads attach comments + liked/bookmarked via feed_post_id", async () => {
    const meatbag = {
      id: "user-123",
      display_name: "Stuie",
      username: "stuie",
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
    const upload = {
      id: "up-1",
      title: "My AI Art",
      feed_post_id: "post-xyz",
      comment_count: 2,
    };
    fake.results = [
      [], // no persona
      [meatbag],
      [upload],
      [{ total_uploads: 1, total_likes: 3, total_comments: 2, total_views: 99 }],
      // enrichment queries (because feedPostIds.length > 0):
      [
        {
          id: "c-1",
          content: "nice work",
          created_at: "2026-04-20T01:00:00Z",
          like_count: 0,
          post_id: "post-xyz",
          parent_comment_id: null,
          parent_comment_type: null,
          username: "ai",
          display_name: "AI Commenter",
          avatar_emoji: "🤖",
          avatar_url: null,
          is_human: false,
        },
      ], // getAiComments
      [], // getHumanComments
      [{ post_id: "post-xyz" }], // getLikedSet
      [{ post_id: "post-xyz" }], // getBookmarkedSet
    ];
    const res = await callGet("?username=stuie&session_id=user-1");
    const body = (await res.json()) as {
      uploads: Array<{
        id: string;
        comments: Array<{ id: string }>;
        liked: boolean;
        bookmarked: boolean;
      }>;
    };
    expect(body.uploads[0]?.comments).toHaveLength(1);
    expect(body.uploads[0]?.comments[0]?.id).toBe("c-1");
    expect(body.uploads[0]?.liked).toBe(true);
    expect(body.uploads[0]?.bookmarked).toBe(true);
  });

  it("B2: meatbag uploads with no feed_post_id skip enrichment queries", async () => {
    fake.results = [
      [],
      [
        {
          id: "user-123",
          display_name: "Stuie",
          username: "stuie",
          avatar_emoji: "🧑",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
          tiktok_handle: null,
          youtube_handle: null,
          website_url: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
      [{ id: "up-1", feed_post_id: null }], // no feed_post_id
      [{ total_uploads: 1, total_likes: 0, total_comments: 0, total_views: 0 }],
    ];
    await callGet("?username=stuie&session_id=user-1");
    // 4 calls only: persona-lookup + meatbag-lookup + uploads + stats.
    // No enrichment queries because feedPostIds is empty.
    expect(fake.calls).toHaveLength(4);
  });

  it("meatbag lookup normalises username to lowercase for case-insensitive match", async () => {
    fake.results = [
      [], // no persona
      [], // no meatbag
    ];
    await callGet("?username=StuIE");
    const sqlText = fake.calls[1]!.strings.join("?");
    expect(sqlText).toContain("LOWER(username)");
    expect(sqlText).toContain("LOWER(id)");
    expect(fake.calls[1]!.values).toContain("stuie");
  });

  it("Cache-Control is public, s-maxage=30, SWR=300 without session_id", async () => {
    fake.results = [
      [personaRow("glitch-042", "alice")],
      [],
      [statsRow()],
      [],
    ];
    const res = await callGet("?username=alice");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );
  });

  it("B3: Cache-Control flips to private, no-store when session_id present", async () => {
    fake.results = [
      [personaRow("glitch-042", "alice")],
      [], // isFollowing lookup
      [], // getByPersona
      [statsRow()],
      [], // getMedia
    ];
    const res = await callGet("?username=alice&session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("B3: meatbag branch also flips to private, no-store when session_id present", async () => {
    fake.results = [
      [], // no persona
      [
        {
          id: "user-123",
          display_name: "Stuie",
          username: "stuie",
          avatar_emoji: "🧑",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
          tiktok_handle: null,
          youtube_handle: null,
          website_url: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
      [], // no uploads
      [{ total_uploads: 0, total_likes: 0, total_comments: 0, total_views: 0 }],
    ];
    const res = await callGet("?username=stuie&session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("500 with detail on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("?username=alice");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load profile");
    expect(body.detail).toBe("pg down");
  });
});
