/**
 * Integration tests for /api/interact (Slice 1 — like, bookmark, share, view).
 *
 * Catches:
 *   - 400 validation: invalid JSON, missing session_id/action/post_id, invalid action
 *   - 501 with { action } for deferred actions (follow/react/comment/comment_like/subscribe)
 *   - 200 for each supported action, with the right SQL shape
 *   - toggle semantics (like/unlike, bookmark/unbookmark)
 *   - trackInterest side-effect fires for like and share (not for bookmark/view)
 *   - GREATEST(0, …) guard on like_count decrement
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

async function callPost(body: unknown, rawBody = false) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/interact", {
    method: "POST",
    body: rawBody ? (body as string) : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function sqlOf(call: SqlCall): string {
  return call.strings.join("?");
}

describe("POST /api/interact (Slice 1)", () => {
  // ── Validation ─────────────────────────────────────────────────────

  it("400 on invalid JSON", async () => {
    const res = await callPost("not-json", true);
    expect(res.status).toBe(400);
  });

  it("400 on missing session_id", async () => {
    const res = await callPost({ action: "like", post_id: "p-1" });
    expect(res.status).toBe(400);
  });

  it("400 on missing action", async () => {
    const res = await callPost({ session_id: "u-1", post_id: "p-1" });
    expect(res.status).toBe(400);
  });

  it("400 on missing post_id for a supported action", async () => {
    const res = await callPost({ session_id: "u-1", action: "like" });
    expect(res.status).toBe(400);
  });

  it("400 on unknown action (neither supported nor deferred)", async () => {
    const res = await callPost({ session_id: "u-1", action: "explode", post_id: "p-1" });
    expect(res.status).toBe(400);
  });

  // ── Deferred actions ───────────────────────────────────────────────

  it.each(["follow", "react", "comment", "comment_like", "subscribe"])(
    "501 action_not_yet_migrated for %s",
    async (action) => {
      const res = await callPost({ session_id: "u-1", post_id: "p-1", action });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string; action: string };
      expect(body.error).toBe("action_not_yet_migrated");
      expect(body.action).toBe(action);
    },
  );

  // ── like ───────────────────────────────────────────────────────────

  it("like: first press inserts, increments counter, tracks interest", async () => {
    fake.results = [
      [], // no existing like
      [], // insert ack
      [], // UPDATE posts like_count
      [{ hashtags: "foo,bar", persona_type: "comic" }], // trackInterest: post lookup
      [], [], [], // 3x interest upserts (comic, foo, bar)
      [], // human_users upsert
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "like",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; action: string };
    expect(body).toEqual({ success: true, action: "liked" });

    const inserted = sqlOf(fake.calls[1]!);
    expect(inserted).toContain("INSERT INTO human_likes");
    const updated = sqlOf(fake.calls[2]!);
    expect(updated).toContain("like_count = like_count + 1");
  });

  it("like: second press deletes, decrements with GREATEST(0, …) guard", async () => {
    fake.results = [
      [{ id: "like-1" }], // existing row
      [], // delete ack
      [], // UPDATE posts
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "like",
    });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("unliked");

    const updateSql = sqlOf(fake.calls[2]!);
    expect(updateSql).toContain("GREATEST(0, like_count - 1)");
  });

  it("like: trackInterest is skipped when post lookup returns empty", async () => {
    fake.results = [
      [], // no existing
      [], // insert ack
      [], // UPDATE
      [], // trackInterest post lookup → empty
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "ghost",
      action: "like",
    });
    expect(res.status).toBe(200);
    // Only 4 calls — no interest upserts fired.
    expect(fake.calls).toHaveLength(4);
  });

  // ── bookmark ───────────────────────────────────────────────────────

  it("bookmark: first press inserts", async () => {
    fake.results = [[], []]; // no existing, insert ack
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "bookmark",
    });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("bookmarked");
    expect(sqlOf(fake.calls[1]!)).toContain("INSERT INTO human_bookmarks");
  });

  it("bookmark: second press deletes", async () => {
    fake.results = [[{ id: "bm-1" }], []]; // existing row, delete ack
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "bookmark",
    });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("unbookmarked");
    expect(sqlOf(fake.calls[1]!)).toContain("DELETE FROM human_bookmarks");
  });

  it("bookmark: does NOT fire trackInterest", async () => {
    fake.results = [[], []];
    await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "bookmark",
    });
    expect(fake.calls).toHaveLength(2);
  });

  // ── share ──────────────────────────────────────────────────────────

  it("share: increments counter + tracks interest", async () => {
    fake.results = [
      [], // UPDATE share_count
      [{ hashtags: "x,y", persona_type: "news" }], // trackInterest lookup
      [], [], [], // upserts (news, x, y)
      [], // human_users upsert
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "share",
    });
    const body = (await res.json()) as { success: boolean; action: string };
    expect(body).toEqual({ success: true, action: "shared" });

    expect(sqlOf(fake.calls[0]!)).toContain("share_count = share_count + 1");
  });

  // ── view ───────────────────────────────────────────────────────────

  it("view: inserts human_view_history, no counter, no trackInterest", async () => {
    fake.results = [[]];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "view",
    });
    const body = (await res.json()) as { success: boolean; action: string };
    expect(body).toEqual({ success: true, action: "viewed" });

    expect(fake.calls).toHaveLength(1);
    expect(sqlOf(fake.calls[0]!)).toContain("INSERT INTO human_view_history");
  });

  // ── Error handling ─────────────────────────────────────────────────

  it("500 with detail when DB throws during like", async () => {
    fake.throwOnNextCall = new Error("neon down");
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "like",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to record interaction");
    expect(body.detail).toBe("neon down");
  });
});
