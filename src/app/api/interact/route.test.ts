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

describe("POST /api/interact (Slices 1 + 2)", () => {
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

  it.each(["comment", "comment_like", "subscribe"])(
    "501 action_not_yet_migrated for %s (Slice 2 removes follow + react from this list)",
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

  // ── Slice 2 — follow ───────────────────────────────────────────────

  it("follow: 400 on missing persona_id", async () => {
    const res = await callPost({ session_id: "u-1", action: "follow" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing persona_id");
  });

  it("follow: first press inserts subscription + increments follower_count", async () => {
    // Stub Math.random so maybeAIFollowBack doesn't fire (skip the follow-back SQL).
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      fake.results = [
        [], // no existing subscription
        [], // INSERT ack
        [], // UPDATE follower_count
      ];
      const res = await callPost({
        session_id: "u-1",
        persona_id: "glitch-001",
        action: "follow",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; action: string };
      expect(body).toEqual({ success: true, action: "followed" });

      expect(sqlOf(fake.calls[1]!)).toContain("INSERT INTO human_subscriptions");
      expect(sqlOf(fake.calls[2]!)).toContain("follower_count = follower_count + 1");
    } finally {
      rng.mockRestore();
    }
  });

  it("follow: second press deletes + decrements with GREATEST guard", async () => {
    fake.results = [[{ id: "sub-1" }], [], []];
    const res = await callPost({
      session_id: "u-1",
      persona_id: "glitch-001",
      action: "follow",
    });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("unfollowed");
    expect(sqlOf(fake.calls[2]!)).toContain("GREATEST(0, follower_count - 1)");
  });

  it("follow: maybeAIFollowBack fires when roll passes + AI not already following", async () => {
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.01); // < 0.40
    try {
      fake.results = [
        [], // no existing subscription
        [], // INSERT human_subscriptions
        [], // UPDATE follower_count
        [], // maybeAIFollowBack: not already following
        [], // INSERT ai_persona_follows
        [{ display_name: "Architect Bot" }], // SELECT display_name
        [], // INSERT notifications
      ];
      const res = await callPost({
        session_id: "u-1",
        persona_id: "glitch-001",
        action: "follow",
      });
      expect(res.status).toBe(200);
      expect(fake.calls).toHaveLength(7);
      expect(sqlOf(fake.calls[4]!)).toContain("INSERT INTO ai_persona_follows");
      expect(sqlOf(fake.calls[6]!)).toContain("INSERT INTO notifications");
      expect(fake.calls[6]!.values.some((v) => String(v).includes("Architect Bot"))).toBe(true);
    } finally {
      rng.mockRestore();
    }
  });

  it("follow: maybeAIFollowBack skipped when AI already follows", async () => {
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.01);
    try {
      fake.results = [
        [], // no existing subscription
        [], // INSERT human_subscriptions
        [], // UPDATE follower_count
        [{ id: "already" }], // AI already follows
      ];
      const res = await callPost({
        session_id: "u-1",
        persona_id: "glitch-001",
        action: "follow",
      });
      expect(res.status).toBe(200);
      // Exactly 4 calls — no follow-back insert, no notification insert.
      expect(fake.calls).toHaveLength(4);
    } finally {
      rng.mockRestore();
    }
  });

  // ── Slice 2 — react ────────────────────────────────────────────────

  it("react: 400 on missing post_id", async () => {
    const res = await callPost({
      session_id: "u-1",
      emoji: "funny",
      action: "react",
    });
    expect(res.status).toBe(400);
  });

  it("react: 400 on missing emoji", async () => {
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "react",
    });
    expect(res.status).toBe(400);
  });

  it("react: 400 with 'Invalid emoji:' on invalid emoji value", async () => {
    fake.results = [[]]; // existing check fires before validation throws? no — validation first, no DB hit.
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      emoji: "rainbow",
      action: "react",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid emoji");
  });

  it("react: first press inserts + upserts content_feedback with scored formula", async () => {
    fake.results = [
      [], // no existing reaction
      [], // INSERT emoji_reactions
      [{ channel_id: "ch-1" }], // SELECT posts.channel_id
      [], // INSERT content_feedback (on conflict upsert)
      [{ hashtags: "foo", persona_type: "comic" }], // trackInterest lookup
      [], [], // interest upserts (comic, foo)
      [], // human_users upsert
      // getReactionCounts
      [
        { emoji: "funny", count: 1 },
      ],
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      emoji: "funny",
      action: "react",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      action: string;
      emoji: string;
      counts: Record<string, number>;
    };
    expect(body.success).toBe(true);
    expect(body.action).toBe("reacted");
    expect(body.emoji).toBe("funny");
    expect(body.counts).toEqual({ funny: 1, sad: 0, shocked: 0, crap: 0 });

    const upsertSql = sqlOf(fake.calls[3]!);
    expect(upsertSql).toContain("INSERT INTO content_feedback");
    expect(upsertSql).toContain("ON CONFLICT (post_id)");
  });

  it("react: second press deletes + decrements with GREATEST guard", async () => {
    fake.results = [
      [{ id: "r-1" }], // existing reaction
      [], // DELETE emoji_reactions
      [], // UPDATE content_feedback
      // getReactionCounts
      [],
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      emoji: "sad",
      action: "react",
    });
    const body = (await res.json()) as { action: string; counts: Record<string, number> };
    expect(body.action).toBe("unreacted");
    expect(body.counts).toEqual({ funny: 0, sad: 0, shocked: 0, crap: 0 });
    expect(sqlOf(fake.calls[2]!)).toContain("GREATEST(0, sad_count");
  });
});
