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

// Prevents triggerAIReply from making real AI API calls in tests.
vi.mock("@/lib/ai/generate", () => ({
  generateReplyToHuman: vi.fn().mockResolvedValue(""),
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

describe("POST /api/interact (all 9 actions)", () => {
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

  it.each(["honk"])(
    "400 Invalid action for unknown %s (no more 501s — all 9 actions migrated)",
    async (action) => {
      const res = await callPost({ session_id: "u-1", post_id: "p-1", action });
      expect(res.status).toBe(400);
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
      // Coin-award side-effects (this IS the first like — count = 1).
      [{ count: 1 }], // SELECT COUNT(*) human_likes → 1
      [], // UPSERT glitch_coins
      [], // INSERT coin_transactions
      [{ persona_id: "persona-p-1" }], // SELECT persona_id FROM posts
      [], // UPSERT ai_persona_coins
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
      [], // trackInterest post lookup → empty (skips interest upserts)
      // Coin-award paths still run their lookup SELECTs but try/catch swallows any awards.
      [], // SELECT COUNT(*) human_likes — empty, so no first-like bonus
      [], // SELECT persona_id FROM posts — empty, so no persona coins
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "ghost",
      action: "like",
    });
    expect(res.status).toBe(200);
    // 4 action calls + 2 coin-award lookup SELECTs (no upserts because both return empty).
    expect(fake.calls).toHaveLength(6);
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

  // ── Slice 3 — comment ──────────────────────────────────────────────

  it("comment: 400 on missing post_id", async () => {
    const res = await callPost({
      session_id: "u-1",
      content: "hi",
      action: "comment",
    });
    expect(res.status).toBe(400);
  });

  it("comment: 400 on missing content", async () => {
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "comment",
    });
    expect(res.status).toBe(400);
  });

  it("comment: 400 on whitespace-only content", async () => {
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "   ",
      action: "comment",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Comment cannot be empty");
  });

  it("comment: inserts human_comments + increments counter + tracks interest", async () => {
    fake.results = [
      [], // INSERT human_comments
      [], // UPDATE comment_count
      [{ hashtags: "a,b", persona_type: "host" }], // trackInterest: post lookup
      [], [], [], // 3 interest upserts
      [], // human_users upsert
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "  great post  ",
      display_name: " Stu ",
      action: "comment",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      action: string;
      comment: {
        id: string;
        content: string;
        display_name: string;
        username: string;
        is_human: boolean;
        like_count: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.action).toBe("commented");
    expect(body.comment.content).toBe("great post"); // trimmed
    expect(body.comment.display_name).toBe("Stu"); // trimmed
    expect(body.comment.username).toBe("human");
    expect(body.comment.is_human).toBe(true);
    expect(body.comment.like_count).toBe(0);

    expect(sqlOf(fake.calls[0]!)).toContain("INSERT INTO human_comments");
    expect(sqlOf(fake.calls[1]!)).toContain("comment_count = comment_count + 1");
  });

  it("comment: truncates content to 300 chars", async () => {
    fake.results = [
      [], [], // insert + update
      [], // trackInterest lookup (empty → skip interest upserts)
    ];
    const long = "x".repeat(500);
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: long,
      action: "comment",
    });
    const body = (await res.json()) as { comment: { content: string } };
    expect(body.comment.content.length).toBe(300);
  });

  it("comment: defaults display_name to 'Meat Bag' when missing", async () => {
    fake.results = [[], [], []];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "hello",
      action: "comment",
    });
    const body = (await res.json()) as { comment: { display_name: string } };
    expect(body.comment.display_name).toBe("Meat Bag");
  });

  it("comment: passes through parent_comment_id and parent_comment_type", async () => {
    fake.results = [[], [], []];
    await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "reply",
      parent_comment_id: "parent-1",
      parent_comment_type: "ai",
      action: "comment",
    });
    expect(fake.calls[0]!.values).toContain("parent-1");
    expect(fake.calls[0]!.values).toContain("ai");
  });

  // ── Slice 3 — comment_like ─────────────────────────────────────────

  it("comment_like: 400 on missing comment_id", async () => {
    const res = await callPost({
      session_id: "u-1",
      comment_type: "human",
      action: "comment_like",
    });
    expect(res.status).toBe(400);
  });

  it("comment_like: 400 on missing comment_type", async () => {
    const res = await callPost({
      session_id: "u-1",
      comment_id: "c-1",
      action: "comment_like",
    });
    expect(res.status).toBe(400);
  });

  it("comment_like: human type hits human_comments on add", async () => {
    fake.results = [
      [], // no existing
      [], // INSERT comment_likes
      [], // UPDATE human_comments
    ];
    const res = await callPost({
      session_id: "u-1",
      comment_id: "c-1",
      comment_type: "human",
      action: "comment_like",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("comment_liked");
    expect(sqlOf(fake.calls[2]!)).toContain(
      "UPDATE human_comments SET like_count = like_count + 1",
    );
  });

  it("comment_like: ai type hits posts.like_count on add", async () => {
    fake.results = [[], [], []];
    await callPost({
      session_id: "u-1",
      comment_id: "ai-reply-1",
      comment_type: "ai",
      action: "comment_like",
    });
    expect(sqlOf(fake.calls[2]!)).toContain(
      "UPDATE posts SET like_count = like_count + 1",
    );
  });

  it("comment_like: remove path decrements with GREATEST guard", async () => {
    fake.results = [
      [{ id: "like-1" }], // existing
      [], // DELETE
      [], // UPDATE
    ];
    const res = await callPost({
      session_id: "u-1",
      comment_id: "c-1",
      comment_type: "human",
      action: "comment_like",
    });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("comment_unliked");
    expect(sqlOf(fake.calls[2]!)).toContain("GREATEST(0, like_count - 1)");
  });

  // ── subscribe (was Slice 6, ran early) ─────────────────────────────

  it("subscribe: 400 on missing post_id", async () => {
    const res = await callPost({ session_id: "u-1", action: "subscribe" });
    expect(res.status).toBe(400);
  });

  it("subscribe: 404 when post doesn't exist", async () => {
    fake.results = [[]]; // persona_id lookup empty
    const res = await callPost({
      session_id: "u-1",
      post_id: "ghost",
      action: "subscribe",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Post not found");
  });

  it("subscribe: 200 with action 'subscribed' on fresh follow", async () => {
    // Stub Math.random so maybeAIFollowBack skips.
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      fake.results = [
        [{ persona_id: "glitch-001" }], // SELECT persona_id
        [], // toggleFollow existing check (no row)
        [], // INSERT human_subscriptions
        [], // UPDATE follower_count
        // trackInterest (post lookup)
        [{ hashtags: null, persona_type: null }],
        // human_users upsert
        [],
      ];
      const res = await callPost({
        session_id: "u-1",
        post_id: "p-1",
        action: "subscribe",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; action: string };
      expect(body).toEqual({ success: true, action: "subscribed" });
    } finally {
      rng.mockRestore();
    }
  });

  it("subscribe: 200 with action 'unsubscribed' when already followed", async () => {
    fake.results = [
      [{ persona_id: "glitch-001" }], // persona_id lookup
      [{ id: "sub-1" }], // existing subscription
      [], // DELETE human_subscriptions
      [], // UPDATE follower_count GREATEST
      // NO trackInterest on the unsubscribe path
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "subscribe",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; action: string };
    expect(body).toEqual({ success: true, action: "unsubscribed" });
  });

  // ── Coin-award retrofit (was Slice 5) ─────────────────────────────

  it("like: awards first-like bonus when count returns 1", async () => {
    // Sequence: check (0), insert (1), update (2), trackInterest lookup empty (3),
    //   count=1 (4), glitch_coins upsert (5), coin_transactions (6),
    //   post persona lookup (7), ai_persona_coins upsert (8).
    fake.results = [
      [], [], [],
      [],
      [{ count: 1 }], [], [],
      [{ persona_id: "persona-1" }], [],
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "like",
    });
    expect(res.status).toBe(200);
    const coinCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO glitch_coins"),
    );
    expect(coinCall).toBeDefined();
    expect(coinCall!.values).toContain(2); // firstLike amount
    const transactionCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO coin_transactions"),
    );
    expect(transactionCall).toBeDefined();
    expect(transactionCall!.values).toContain("First like bonus");
  });

  it("like: skips first-like bonus when count returns > 1", async () => {
    fake.results = [
      [], [], [],
      [],
      [{ count: 5 }], // not first
      [{ persona_id: "persona-1" }], [], // persona coins still fire
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "like",
    });
    expect(res.status).toBe(200);
    const coinCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO glitch_coins"),
    );
    expect(coinCall).toBeUndefined();
  });

  it("like: always awards persona coins when post exists, regardless of first-like state", async () => {
    fake.results = [
      [], [], [],
      [],
      [{ count: 99 }], // not first
      [{ persona_id: "persona-1" }], [],
    ];
    await callPost({ session_id: "u-1", post_id: "p-1", action: "like" });
    const personaCoinCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO ai_persona_coins"),
    );
    expect(personaCoinCall).toBeDefined();
    expect(personaCoinCall!.values).toContain(1); // personaLikeReceived
    expect(personaCoinCall!.values).toContain("persona-1");
  });

  it("like: coin-award failure does NOT break the like action (try/catch swallows)", async () => {
    fake.results = [
      [], [], [],
      [],
      [{ bogus: "no count field" }], // count is undefined → first-like check false, no bonus
      [{ persona_id: "persona-1" }], [],
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      action: "like",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("liked");
    // Persona coins still awarded even when the count query returned weird shape.
    const personaCoinCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO ai_persona_coins"),
    );
    expect(personaCoinCall).toBeDefined();
  });

  it("comment: awards first-comment bonus when count returns 1", async () => {
    fake.results = [
      [], // INSERT human_comments
      [], // UPDATE comment_count
      [], // trackInterest post lookup (empty → skip interest upserts)
      [{ count: 1 }], // first comment!
      [], // UPSERT glitch_coins
      [], // INSERT coin_transactions
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "first post",
      action: "comment",
    });
    expect(res.status).toBe(200);
    const coinCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO glitch_coins"),
    );
    expect(coinCall).toBeDefined();
    expect(coinCall!.values).toContain(15); // firstComment reward
    const transactionCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO coin_transactions"),
    );
    expect(transactionCall!.values).toContain("First comment bonus");
  });

  it("comment: skips first-comment bonus when count returns > 1", async () => {
    fake.results = [
      [], [], [], // insert, update, trackInterest lookup (empty)
      [{ count: 7 }], // not first
    ];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "hello",
      action: "comment",
    });
    expect(res.status).toBe(200);
    const coinCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO glitch_coins"),
    );
    expect(coinCall).toBeUndefined();
  });

  // ── AI auto-reply (triggerAIReply) ──────────────────────────────────

  it("comment: response is unaffected by fire-and-forget AI auto-reply", async () => {
    // Response must be correct even when triggerAIReply fires async.
    fake.results = [[], [], []];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "nice post",
      action: "comment",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; action: string };
    expect(body.success).toBe(true);
    expect(body.action).toBe("commented");
  });

  it("comment: AI auto-reply not triggered for reply comments (parent set)", async () => {
    // When parent_comment_id is present the trigger must skip immediately —
    // verify the response is still 200 with no regression.
    fake.results = [[], [], []];
    const res = await callPost({
      session_id: "u-1",
      post_id: "p-1",
      content: "replying to you",
      parent_comment_id: "parent-comment-99",
      parent_comment_type: "human",
      action: "comment",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("commented");
  });
});
