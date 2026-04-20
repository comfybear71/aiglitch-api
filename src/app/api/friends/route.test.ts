/**
 * Integration tests for /api/friends (meatbag ↔ meatbag social graph).
 *
 * GET dispatches on `?type=`:
 *   - default → `{ friends: [...] }`
 *   - ?type=following → `{ following: [...] }` (AI personas user follows)
 *   - ?type=ai_followers → `{ ai_followers: [...] }` (AI personas following user)
 *
 * Missing session_id → 200 with `{ friends: [], following: [], ai_followers: [] }`
 * (legacy parity — no 400).
 *
 * POST action="add_friend":
 *   - 400 Missing fields / Missing friend_username / Invalid action
 *   - 404 User not found
 *   - 400 Cannot friend yourself
 *   - 409 Already friends
 *   - 200 { success, friend } + bidirectional human_friends INSERT + +25 GLITCH bonus
 *
 * Cache-Control: private, no-store (session-personalised)
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
  const req = new NextRequest(`http://localhost/api/friends${query}`);
  return GET(req);
}

async function callPost(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/friends", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/friends", () => {
  it("returns empty envelope when session_id missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      friends: unknown[];
      following: unknown[];
      ai_followers: unknown[];
    };
    expect(body).toEqual({ friends: [], following: [], ai_followers: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns friends list by default", async () => {
    fake.results = [
      [
        {
          display_name: "Bob",
          username: "bob",
          avatar_emoji: "🧑",
          avatar_url: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as { friends: Array<{ username: string }> };
    expect(body.friends).toHaveLength(1);
    expect(body.friends[0]?.username).toBe("bob");
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("FROM human_friends hf");
    expect(sql).toContain("JOIN human_users hu");
    expect(sql).toContain("ORDER BY hf.created_at DESC");
  });

  it("?type=following returns AI personas user follows", async () => {
    fake.results = [
      [
        {
          persona_id: "glitch-042",
          username: "alice_ai",
          display_name: "Alice",
          avatar_emoji: "🤖",
          persona_type: "general",
        },
      ],
    ];
    const res = await callGet("?session_id=user-1&type=following");
    const body = (await res.json()) as {
      following: Array<{ persona_id: string }>;
    };
    expect(body.following).toHaveLength(1);
    expect(body.following[0]?.persona_id).toBe("glitch-042");
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("FROM human_subscriptions hs");
  });

  it("?type=ai_followers returns AI personas following user", async () => {
    fake.results = [
      [
        {
          persona_id: "glitch-055",
          username: "flat_earth_facts",
          display_name: "LEVEL.exe",
          avatar_emoji: "🌍",
          persona_type: "flat_earther",
        },
      ],
    ];
    const res = await callGet("?session_id=user-1&type=ai_followers");
    const body = (await res.json()) as {
      ai_followers: Array<{ username: string }>;
    };
    expect(body.ai_followers[0]?.username).toBe("flat_earth_facts");
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("FROM ai_persona_follows af");
  });

  it("Cache-Control is private, no-store", async () => {
    fake.results = [[]];
    const res = await callGet("?session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("500 on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load friends");
    expect(body.detail).toBe("pg down");
  });
});

describe("POST /api/friends", () => {
  it("400 when session_id missing", async () => {
    const res = await callPost({ action: "add_friend" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing fields");
  });

  it("400 when action missing", async () => {
    const res = await callPost({ session_id: "user-1" });
    expect(res.status).toBe(400);
  });

  it("400 on unknown action", async () => {
    const res = await callPost({ session_id: "user-1", action: "remove_friend" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid action");
  });

  it("400 when friend_username missing", async () => {
    const res = await callPost({ session_id: "user-1", action: "add_friend" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing friend_username");
  });

  it("404 when friend_username not found", async () => {
    fake.results = [[]]; // user lookup empty
    const res = await callPost({
      session_id: "user-1",
      action: "add_friend",
      friend_username: "ghost",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("User not found");
  });

  it("400 when sending to yourself", async () => {
    fake.results = [
      [{ session_id: "user-1", username: "me", display_name: "Me" }],
    ];
    const res = await callPost({
      session_id: "user-1",
      action: "add_friend",
      friend_username: "me",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Cannot friend yourself");
  });

  it("409 when already friends", async () => {
    fake.results = [
      [{ session_id: "bob-session", username: "bob", display_name: "Bob" }],
      [{ id: "existing-friendship" }],
    ];
    const res = await callPost({
      session_id: "user-1",
      action: "add_friend",
      friend_username: "bob",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Already friends");
  });

  it("happy path: 200 + bidirectional INSERT + +25 GLITCH to both", async () => {
    fake.results = [
      [{ session_id: "bob-session", username: "bob", display_name: "Bob" }], // user lookup
      [], // no existing friendship
      [], // INSERT forward
      [], // INSERT reverse with ON CONFLICT
      // awardCoins (sessionId): INSERT glitch_coins + INSERT coin_transactions
      [],
      [],
      // awardCoins (friend): INSERT glitch_coins + INSERT coin_transactions
      [],
      [],
    ];
    const res = await callPost({
      session_id: "user-1",
      action: "add_friend",
      friend_username: "bob",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      friend: { username: string; display_name: string };
    };
    expect(body.success).toBe(true);
    expect(body.friend.username).toBe("bob");

    // Reverse INSERT uses ON CONFLICT
    const reverseSql = sqlOf(fake.calls[3]!);
    expect(reverseSql).toContain("INSERT INTO human_friends");
    expect(reverseSql).toContain("ON CONFLICT");

    // Both parties awarded 25 GLITCH
    const awardSessionTxn = sqlOf(fake.calls[5]!);
    expect(awardSessionTxn).toContain("INSERT INTO coin_transactions");
    expect(fake.calls[5]!.values).toContain(25);
    expect(fake.calls[5]!.values).toContain("New friend bonus");
    const awardFriendTxn = sqlOf(fake.calls[7]!);
    expect(awardFriendTxn).toContain("INSERT INTO coin_transactions");
    expect(fake.calls[7]!.values).toContain(25);
  });

  it("lowercases friend_username before lookup (legacy parity)", async () => {
    fake.results = [[]];
    await callPost({
      session_id: "user-1",
      action: "add_friend",
      friend_username: "BoB",
    });
    expect(fake.calls[0]!.values).toContain("bob");
  });
});
