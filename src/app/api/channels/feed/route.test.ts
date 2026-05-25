/**
 * Tests for /api/channels/feed.
 *
 * Critical: the prior implementation was a stub that took `?channel_id=`
 * and returned only `{posts}` — that shape mismatch silently broke every
 * channel detail page after the strangler flip landed. These tests pin
 * the legacy shape so any future regression fails CI loudly:
 *
 *   ?slug=...           → REQUIRED, 400 if missing
 *   channel not found   → 404
 *   happy path response → { channel, personas, posts, nextCursor, nextOffset }
 *
 * Internals (repo helpers, batch reactions, comment threading) are mocked
 * so the route's own DB + shape contract is what gets exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/repositories/posts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/repositories/posts")>(
    "@/lib/repositories/posts",
  );
  return {
    ...actual,
    getAiComments: vi.fn(async () => []),
    getHumanComments: vi.fn(async () => []),
    getBookmarkedSet: vi.fn(async () => new Set<string>()),
    threadComments: vi.fn(() => new Map()),
  };
});
vi.mock("@/lib/repositories/interactions", () => ({
  getBatchReactions: vi.fn(async () => ({})),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function buildRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/channels/feed${query}`);
}

describe("GET /api/channels/feed", () => {
  it("400 when slug missing — pins the slug-not-channel_id contract", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slug/);
  });

  it("404 when channel slug doesn't exist", async () => {
    fake.results = [[]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?slug=does-not-exist"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Channel not found");
  });

  it("happy path returns full envelope shape — pins channel-page consumer contract", async () => {
    fake.results = [
      [{
        id: "ch-fail",
        name: "AI Fail Army",
        slug: "ai-fail-army",
        emoji: "💥",
        description: "Things go wrong",
        content_rules: '{"tone":"comedy"}',
        schedule: null,
        subscriber_count: 100,
        genre: "comedy",
      }],
      [],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?slug=ai-fail-army"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("channel");
    expect(body).toHaveProperty("personas");
    expect(body).toHaveProperty("posts");
    expect(body).toHaveProperty("nextCursor");
    expect(body.channel.slug).toBe("ai-fail-army");
    expect(body.channel.name).toBe("AI Fail Army");
    expect(body.channel.emoji).toBe("💥");
    expect(body.channel.content_rules).toEqual({ tone: "comedy" });
    expect(body.channel.subscribed).toBe(false);
    expect(body.posts).toEqual([]);
    expect(body.personas).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("populated channel returns posts with overlays + personas", async () => {
    fake.results = [
      [{
        id: "ch-fail",
        name: "AI Fail Army",
        slug: "ai-fail-army",
        emoji: "💥",
        description: null,
        content_rules: null,
        schedule: null,
        subscriber_count: 0,
        genre: "comedy",
      }],
      [
        {
          id: "p1",
          content: "first post",
          created_at: "2026-05-25T00:00:00Z",
          media_url: "https://blob/p1.mp4",
          media_type: "video",
          media_source: null,
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🦊",
          avatar_url: null,
          persona_type: "ai",
          persona_bio: null,
        },
      ],
      [],
      [{
        role: "host",
        persona_id: "alice",
        username: "alice",
        display_name: "Alice",
        avatar_emoji: "🦊",
        avatar_url: null,
      }],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?slug=ai-fail-army"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].id).toBe("p1");
    expect(body.posts[0].comments).toEqual([]);
    expect(body.posts[0].bookmarked).toBe(false);
    expect(body.posts[0].reactionCounts).toEqual({ funny: 0, sad: 0, shocked: 0, crap: 0 });
    expect(body.posts[0].userReactions).toEqual([]);
    expect(body.posts[0].socialLinks).toEqual({});
    expect(body.personas).toHaveLength(1);
    expect(body.personas[0].username).toBe("alice");
  });

  it("sets Cache-Control header on the populated path", async () => {
    // Note: the empty-channel short-circuit doesn't set Cache-Control
    // (matches legacy). Need at least one post to exercise the cache path.
    fake.results = [
      [{
        id: "ch-fail",
        name: "AI Fail Army",
        slug: "ai-fail-army",
        emoji: "💥",
        description: null,
        content_rules: null,
        schedule: null,
        subscriber_count: 0,
        genre: "comedy",
      }],
      [
        {
          id: "p1",
          content: "post",
          created_at: "2026-05-25T00:00:00Z",
          media_url: "https://blob/p1.mp4",
          media_type: "video",
          media_source: null,
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🦊",
          avatar_url: null,
          persona_type: "ai",
          persona_bio: null,
        },
      ],
      [],
      [],
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?slug=ai-fail-army"));
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });
});
