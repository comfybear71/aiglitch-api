/**
 * Integration tests for /api/channels (GET + POST — first write endpoint).
 *
 * GET path:
 *   - 200 with { channels: [] } shape
 *   - subscribed flag populates when session_id present
 *   - hosts + thumbnail enrichment
 *   - CHANNEL_DEFAULTS applied to missing generation-config fields
 *   - content_rules / schedule JSON parsed when stored as string
 *   - Cache-Control: public, s-maxage=30, SWR=120
 *
 * POST path:
 *   - 400 on missing fields / invalid JSON / invalid action
 *   - 200 { ok: true, action } for subscribe
 *   - 200 { ok: true, action } for unsubscribe (even when nothing was there)
 *   - SQL shape for subscribe: INSERT then UPDATE counter
 *   - SQL shape for unsubscribe: DELETE, then UPDATE counter only if rows were deleted
 *   - 500 wrapping on DB error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[] | { count: number };
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

async function callGet(queryString = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/channels${queryString}`);
  return GET(req);
}

async function callPost(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/channels", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function channelRow(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    slug: `channel-${id}`,
    name: `Channel ${id}`,
    is_active: true,
    is_private: false,
    banner_url: null,
    sort_order: 1,
    created_at: "2026-04-19T00:00:00Z",
    persona_count: 3,
    actual_post_count: 10,
    content_rules: null,
    schedule: null,
    show_title_page: null,
    show_director: null,
    show_credits: null,
    scene_count: null,
    scene_duration: null,
    default_director: null,
    generation_genre: null,
    short_clip_mode: null,
    is_music_channel: null,
    auto_publish_to_feed: null,
    ...extras,
  };
}

describe("GET /api/channels", () => {
  it("returns 200 with { channels: [] } shape (no session)", async () => {
    fake.results = [[channelRow("ch-1")], [], []]; // channels, hosts, thumbnails
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: Array<Record<string, unknown>> };
    expect(Object.keys(body)).toEqual(["channels"]);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]?.id).toBe("ch-1");
    expect(body.channels[0]?.subscribed).toBe(false);
    expect(body.channels[0]?.personas).toEqual([]);
  });

  it("applies CHANNEL_DEFAULTS to missing generation-config fields", async () => {
    fake.results = [[channelRow("ch-1")], [], []];
    const res = await callGet();
    const body = (await res.json()) as {
      channels: Array<Record<string, unknown>>;
    };
    const c = body.channels[0]!;
    expect(c.show_title_page).toBe(false);
    expect(c.show_director).toBe(false);
    expect(c.show_credits).toBe(false);
    expect(c.scene_duration).toBe(10);
    expect(c.auto_publish_to_feed).toBe(true);
    expect(c.scene_count).toBeNull();
    expect(c.short_clip_mode).toBe(false);
    expect(c.is_music_channel).toBe(false);
  });

  it("parses content_rules/schedule when stored as JSON strings", async () => {
    fake.results = [
      [
        channelRow("ch-1", {
          content_rules: '{"foo":1}',
          schedule: '{"cron":"* * * * *"}',
        }),
      ],
      [],
      [],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      channels: Array<Record<string, unknown>>;
    };
    const c = body.channels[0]!;
    expect(c.content_rules).toEqual({ foo: 1 });
    expect(c.schedule).toEqual({ cron: "* * * * *" });
  });

  it("populates subscribed flag when session_id matches a row", async () => {
    fake.results = [
      [channelRow("ch-1"), channelRow("ch-2")],
      [{ channel_id: "ch-1" }], // subscriptions
      [], // hosts
      [], // thumbnails
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      channels: Array<{ id: string; subscribed: boolean }>;
    };
    expect(body.channels.find((c) => c.id === "ch-1")?.subscribed).toBe(true);
    expect(body.channels.find((c) => c.id === "ch-2")?.subscribed).toBe(false);
  });

  it("attaches hosts by channel_id", async () => {
    fake.results = [
      [channelRow("ch-1")],
      [],
      [
        {
          channel_id: "ch-1",
          role: "host",
          persona_id: "p-1",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
        },
      ],
      [],
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      channels: Array<{ personas: Array<{ username: string }> }>;
    };
    expect(body.channels[0]?.personas[0]?.username).toBe("alice");
  });

  it("falls back to thumbnail when banner_url is null", async () => {
    fake.results = [
      [channelRow("ch-1", { banner_url: null })],
      [],
      [{ cid: "ch-1", media_url: "https://cdn/thumb.jpg" }],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      channels: Array<{ thumbnail: string | null }>;
    };
    expect(body.channels[0]?.thumbnail).toBe("https://cdn/thumb.jpg");
  });

  it("prefers banner_url over thumbnail", async () => {
    fake.results = [
      [channelRow("ch-1", { banner_url: "https://cdn/banner.jpg" })],
      [],
      [{ cid: "ch-1", media_url: "https://cdn/thumb.jpg" }],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      channels: Array<{ thumbnail: string | null }>;
    };
    expect(body.channels[0]?.thumbnail).toBe("https://cdn/banner.jpg");
  });

  it("sets Cache-Control: public, s-maxage=30, SWR=120", async () => {
    fake.results = [[], [], []];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("returns 500 when channels query throws", async () => {
    fake.throwOnNextCall = new Error("boom");
    const res = await callGet();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/channels", () => {
  it("400 on invalid JSON body", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/channels", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400 on missing session_id", async () => {
    const res = await callPost({ channel_id: "ch-1", action: "subscribe" });
    expect(res.status).toBe(400);
  });

  it("400 on missing channel_id", async () => {
    const res = await callPost({ session_id: "user-1", action: "subscribe" });
    expect(res.status).toBe(400);
  });

  it("400 on missing action", async () => {
    const res = await callPost({ session_id: "user-1", channel_id: "ch-1" });
    expect(res.status).toBe(400);
  });

  it("400 on invalid action value", async () => {
    const res = await callPost({
      session_id: "user-1",
      channel_id: "ch-1",
      action: "toggle",
    });
    expect(res.status).toBe(400);
  });

  it("subscribe: issues INSERT then UPDATE counter", async () => {
    fake.results = [[], []]; // insert ack, update ack
    const res = await callPost({
      session_id: "user-1",
      channel_id: "ch-1",
      action: "subscribe",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; action: string };
    expect(body).toEqual({ ok: true, action: "subscribe" });
    expect(fake.calls).toHaveLength(2);
    const insertSql = fake.calls[0]!.strings.join("?");
    expect(insertSql).toContain("INSERT INTO channel_subscriptions");
    expect(insertSql).toContain("ON CONFLICT");
    expect(fake.calls[0]!.values).toContain("ch-1");
    expect(fake.calls[0]!.values).toContain("user-1");
    const updateSql = fake.calls[1]!.strings.join("?");
    expect(updateSql).toContain("subscriber_count = subscriber_count + 1");
  });

  it("unsubscribe: DELETE fires, then UPDATE only when rows were deleted", async () => {
    fake.results = [
      { count: 1 }, // deleted rows
      [], // update ack
    ];
    const res = await callPost({
      session_id: "user-1",
      channel_id: "ch-1",
      action: "unsubscribe",
    });
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.strings.join("?")).toContain(
      "DELETE FROM channel_subscriptions",
    );
    expect(fake.calls[1]!.strings.join("?")).toContain(
      "subscriber_count - 1",
    );
  });

  it("unsubscribe: no UPDATE when nothing was deleted", async () => {
    fake.results = [
      { count: 0 }, // deleted rows
    ];
    const res = await callPost({
      session_id: "user-1",
      channel_id: "ch-1",
      action: "unsubscribe",
    });
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(1); // only the DELETE
  });

  it("500 with detail when DB throws during subscribe", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callPost({
      session_id: "user-1",
      channel_id: "ch-1",
      action: "subscribe",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to update subscription");
    expect(body.detail).toBe("pg down");
  });
});
