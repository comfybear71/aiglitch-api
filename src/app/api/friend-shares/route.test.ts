/**
 * Integration tests for /api/friend-shares.
 *
 * GET:
 *   - `{ shares: [] }` when session_id missing (no `unread` field — legacy parity)
 *   - `{ shares, unread }` when session_id present
 *   - unread count coerces Neon's stringified numeric to JS number
 *   - Cache-Control: private, no-store
 *   - 500 wrapping on DB error
 *
 * POST:
 *   - 400 on missing session_id or action
 *   - share: 400 on missing post_id or friend_username
 *   - share: 404 when friend username resolves to nobody
 *   - share: 403 when sender isn't friends with the target
 *   - share: lowercases friend_username for lookup
 *   - share: happy path — INSERT friend_shares row with message (or null)
 *   - mark_read: bulk UPDATE is_read = TRUE where receiver = session + is_read FALSE
 *   - unknown action → 400
 *   - 500 wrapping on DB error during a POST action
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
  const req = new NextRequest(`http://localhost/api/friend-shares${query}`);
  return GET(req);
}

async function callPost(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/friend-shares", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function shareRow(id: string) {
  return {
    id,
    post_id: `post-${id}`,
    message: null,
    is_read: false,
    created_at: "2026-04-20T00:00:00Z",
    sender_name: "Bob",
    sender_avatar: "🧑",
    sender_username: "bob",
    post_content: "hi",
    post_type: "text",
    media_url: null,
    media_type: null,
    persona_name: "Alice",
    persona_avatar: "🤖",
    persona_username: "alice_ai",
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/friend-shares", () => {
  it("returns { shares: [] } when session_id missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ shares: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns { shares, unread } when session_id present", async () => {
    fake.results = [
      [shareRow("s1"), shareRow("s2")], // inbox
      [{ count: 1 }], // unread count
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      shares: Array<{ id: string }>;
      unread: number;
    };
    expect(body.shares).toHaveLength(2);
    expect(body.shares[0]?.id).toBe("s1");
    expect(body.unread).toBe(1);
  });

  it("inbox query joins sender, post, and persona tables", async () => {
    fake.results = [[], [{ count: 0 }]];
    await callGet("?session_id=user-1");
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("FROM friend_shares fs");
    expect(sql).toContain("JOIN human_users hu");
    expect(sql).toContain("JOIN posts p");
    expect(sql).toContain("JOIN ai_personas a");
    expect(sql).toContain("WHERE fs.receiver_session_id");
    expect(sql).toContain("ORDER BY fs.created_at DESC");
    expect(fake.calls[0]!.values).toContain(50);
  });

  it("coerces Neon stringified numeric to number in unread count", async () => {
    fake.results = [[], [{ count: "7" }]]; // string — Neon quirk on COUNT()
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as { unread: unknown };
    expect(typeof body.unread).toBe("number");
    expect(body.unread).toBe(7);
  });

  it("Cache-Control is private, no-store on both branches", async () => {
    // no session
    const resEmpty = await callGet();
    expect(resEmpty.headers.get("Cache-Control")).toBe("private, no-store");
    // with session
    fake.results = [[], [{ count: 0 }]];
    const resReal = await callGet("?session_id=user-1");
    expect(resReal.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("500 on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load shares");
    expect(body.detail).toBe("pg down");
  });
});

describe("POST /api/friend-shares", () => {
  it("400 when session_id missing", async () => {
    const res = await callPost({ action: "share" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing fields");
  });

  it("400 when action missing", async () => {
    const res = await callPost({ session_id: "user-1" });
    expect(res.status).toBe(400);
  });

  it("400 on unknown action", async () => {
    const res = await callPost({ session_id: "user-1", action: "deliver_hotdog" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid action");
  });

  describe("share", () => {
    it("400 when post_id missing", async () => {
      const res = await callPost({
        session_id: "user-1",
        action: "share",
        friend_username: "bob",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Missing post_id or friend_username");
    });

    it("400 when friend_username missing", async () => {
      const res = await callPost({
        session_id: "user-1",
        action: "share",
        post_id: "post-1",
      });
      expect(res.status).toBe(400);
    });

    it("404 when friend username resolves to nobody", async () => {
      fake.results = [[]]; // findFriendSession empty
      const res = await callPost({
        session_id: "user-1",
        action: "share",
        post_id: "post-1",
        friend_username: "ghost",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Friend not found");
    });

    it("403 when sender isn't friends with the target", async () => {
      fake.results = [
        [{ session_id: "bob-session" }], // friend lookup
        [], // friendship check — empty
      ];
      const res = await callPost({
        session_id: "user-1",
        action: "share",
        post_id: "post-1",
        friend_username: "bob",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Not friends with this user");
    });

    it("happy path: INSERTs friend_shares row and returns { success }", async () => {
      fake.results = [
        [{ session_id: "bob-session" }], // findFriendSession
        [{ id: "friendship-1" }], // isFriendWith
        [], // INSERT
      ];
      const res = await callPost({
        session_id: "user-1",
        action: "share",
        post_id: "post-1",
        friend_username: "bob",
        message: "check this out",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      const insertSql = sqlOf(fake.calls[2]!);
      expect(insertSql).toContain("INSERT INTO friend_shares");
      expect(fake.calls[2]!.values).toContain("user-1");
      expect(fake.calls[2]!.values).toContain("bob-session");
      expect(fake.calls[2]!.values).toContain("post-1");
      expect(fake.calls[2]!.values).toContain("check this out");
    });

    it("message defaults to null when omitted", async () => {
      fake.results = [
        [{ session_id: "bob-session" }],
        [{ id: "friendship-1" }],
        [],
      ];
      await callPost({
        session_id: "user-1",
        action: "share",
        post_id: "post-1",
        friend_username: "bob",
      });
      expect(fake.calls[2]!.values).toContain(null);
    });

    it("lowercases friend_username for the lookup (legacy parity)", async () => {
      fake.results = [[]]; // friend lookup, empty — don't care about downstream
      await callPost({
        session_id: "user-1",
        action: "share",
        post_id: "post-1",
        friend_username: "BoB",
      });
      expect(fake.calls[0]!.values).toContain("bob");
    });
  });

  describe("mark_read", () => {
    it("bulk UPDATEs is_read = TRUE where receiver = session + is_read FALSE", async () => {
      fake.results = [[]]; // UPDATE
      const res = await callPost({
        session_id: "user-1",
        action: "mark_read",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      const sql = sqlOf(fake.calls[0]!);
      expect(sql).toContain("UPDATE friend_shares");
      expect(sql).toContain("is_read = TRUE");
      expect(sql).toContain("is_read = FALSE");
      expect(fake.calls[0]!.values).toContain("user-1");
    });
  });

  it("500 wrapping on DB error during a POST action", async () => {
    fake.throwOnNextCall = new Error("pg hiccup");
    const res = await callPost({
      session_id: "user-1",
      action: "mark_read",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to process share action");
    expect(body.detail).toBe("pg hiccup");
  });
});
