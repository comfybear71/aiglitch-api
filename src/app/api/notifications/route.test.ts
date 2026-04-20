/**
 * Integration tests for /api/notifications.
 *
 * GET paths:
 *   - 400 when session_id missing
 *   - { unread } shape when count=1
 *   - { notifications, unread } shape on full list
 *   - Graceful fallback: list errors return empty (legacy parity)
 *   - Cache-Control: private, no-store (session-personalised)
 *
 * POST paths:
 *   - 400 on invalid JSON / missing session_id
 *   - mark_read: UPDATE single notification
 *   - mark_all_read: UPDATE all unread for session
 *   - Unknown action no-ops with success: true
 *   - 500 on DB error
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
  const req = new NextRequest(`http://localhost/api/notifications${query}`);
  return GET(req);
}

async function callPost(body: unknown, rawBody = false) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/notifications", {
    method: "POST",
    body: rawBody ? (body as string) : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/notifications", () => {
  it("400 when session_id is missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session_id required");
  });

  it("count=1 returns { unread }", async () => {
    fake.results = [[{ count: 7 }]];
    const res = await callGet("?session_id=user-1&count=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ unread: 7 });
  });

  it("count=1 returns 0 when query throws (legacy parity)", async () => {
    fake.throwOnNextCall = new Error("boom");
    const res = await callGet("?session_id=user-1&count=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unread: number };
    expect(body.unread).toBe(0);
  });

  it("full list returns { notifications, unread }", async () => {
    fake.results = [
      [
        {
          id: "n1",
          type: "ai_follow",
          post_id: null,
          reply_id: null,
          content_preview: "Alice followed you back! 🤖",
          is_read: false,
          created_at: "2026-04-20T00:00:00Z",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          persona_type: "general",
        },
      ],
      [{ count: 1 }],
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      notifications: Array<{ id: string; type: string; content_preview: string }>;
      unread: number;
    };
    expect(Object.keys(body).sort()).toEqual(["notifications", "unread"]);
    expect(body.notifications[0]?.id).toBe("n1");
    expect(body.notifications[0]?.type).toBe("ai_follow");
    expect(body.unread).toBe(1);
  });

  it("list query issues two parallel SQL calls (list + unread count)", async () => {
    fake.results = [[], [{ count: 0 }]];
    await callGet("?session_id=user-1");
    expect(fake.calls).toHaveLength(2);
    const listSql = sqlOf(fake.calls[0]!);
    expect(listSql).toContain("FROM notifications n");
    expect(listSql).toContain("JOIN ai_personas a");
    expect(fake.calls[0]!.values).toContain(50); // PAGINATION.notifications
    const countSql = sqlOf(fake.calls[1]!);
    expect(countSql).toContain("COUNT(*)::int");
    expect(countSql).toContain("is_read = FALSE");
  });

  it("graceful fallback: list() throws → empty envelope, no 500", async () => {
    fake.throwOnNextCall = new Error("pg hiccup");
    const res = await callGet("?session_id=user-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: unknown[]; unread: number };
    expect(body).toEqual({ notifications: [], unread: 0 });
  });

  it("Cache-Control is private, no-store on the list path", async () => {
    fake.results = [[], [{ count: 0 }]];
    const res = await callGet("?session_id=user-1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("Cache-Control is private, no-store on the count path too", async () => {
    fake.results = [[{ count: 0 }]];
    const res = await callGet("?session_id=user-1&count=1");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("POST /api/notifications", () => {
  it("400 on invalid JSON", async () => {
    const res = await callPost("not-json", true);
    expect(res.status).toBe(400);
  });

  it("400 when session_id is missing", async () => {
    const res = await callPost({ action: "mark_all_read" });
    expect(res.status).toBe(400);
  });

  it("mark_read with notification_id issues a targeted UPDATE", async () => {
    fake.results = [[]];
    const res = await callPost({
      session_id: "user-1",
      action: "mark_read",
      notification_id: "n-123",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("UPDATE notifications SET is_read = TRUE");
    expect(sql).toContain("WHERE id =");
    expect(fake.calls[0]!.values).toContain("n-123");
    expect(fake.calls[0]!.values).toContain("user-1");
  });

  it("mark_read without notification_id is a no-op (legacy parity)", async () => {
    const res = await callPost({
      session_id: "user-1",
      action: "mark_read",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("mark_all_read UPDATEs every unread for the session", async () => {
    fake.results = [[]];
    const res = await callPost({
      session_id: "user-1",
      action: "mark_all_read",
    });
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("UPDATE notifications SET is_read = TRUE");
    expect(sql).toContain("is_read = FALSE");
  });

  it("unknown action is a no-op with success: true", async () => {
    const res = await callPost({
      session_id: "user-1",
      action: "explode" as unknown as "mark_read",
    });
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });

  it("500 with detail when UPDATE throws", async () => {
    fake.throwOnNextCall = new Error("db down");
    const res = await callPost({
      session_id: "user-1",
      action: "mark_all_read",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to update");
    expect(body.detail).toBe("db down");
  });
});
