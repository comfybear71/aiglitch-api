/**
 * Integration tests for /api/events (community events + voting).
 *
 * GET:
 *   - 200 with { success: true, events } shape
 *   - target_persona_ids JSON parsed out of stored string
 *   - user_voted flag flips when session_id provided + vote row exists
 *   - Cache-Control public s-maxage=30 SWR=300
 *   - Legacy-parity: 200 + { success: false, error } on DB error (not 500)
 *
 * POST:
 *   - 400 on missing event_id or session_id
 *   - 404 when event doesn't exist
 *   - 400 when event is not active (completed / processing)
 *   - 200 { action: "voted" } on first press (INSERT + counter++)
 *   - 200 { action: "unvoted" } on second press (DELETE + counter GREATEST)
 *   - Legacy-parity: 200 + success:false on unexpected errors
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
  const req = new NextRequest(`http://localhost/api/events${query}`);
  return GET(req);
}

async function callPost(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/events", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function eventRow(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    title: "Test event",
    description: "desc",
    event_type: "drama",
    status: "active",
    vote_count: 0,
    target_persona_ids: null,
    result_summary: null,
    expires_at: null,
    created_at: "2026-04-20T00:00:00Z",
    ...extras,
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/events", () => {
  it("returns { success: true, events } with empty list when no events match", async () => {
    fake.results = [[]];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; events: unknown[] };
    expect(body).toEqual({ success: true, events: [] });
  });

  it("parses target_persona_ids JSON string into an array", async () => {
    fake.results = [
      [
        eventRow("e1", {
          target_persona_ids: '["glitch-001","glitch-002"]',
        }),
      ],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      events: Array<{ target_persona_ids: string[] }>;
    };
    expect(body.events[0]?.target_persona_ids).toEqual(["glitch-001", "glitch-002"]);
  });

  it("falls back to empty array when target_persona_ids is malformed JSON", async () => {
    fake.results = [[eventRow("e1", { target_persona_ids: "not json" })]];
    const res = await callGet();
    const body = (await res.json()) as {
      events: Array<{ target_persona_ids: string[] }>;
    };
    expect(body.events[0]?.target_persona_ids).toEqual([]);
  });

  it("omits the user_votes query when session_id absent", async () => {
    fake.results = [[eventRow("e1")]];
    await callGet();
    expect(fake.calls).toHaveLength(1);
  });

  it("marks user_voted=true when session has a vote row for that event", async () => {
    fake.results = [
      [eventRow("e1"), eventRow("e2")],
      [{ event_id: "e1" }], // session voted for e1 only
    ];
    const res = await callGet("?session_id=user-1");
    const body = (await res.json()) as {
      events: Array<{ id: string; user_voted: boolean }>;
    };
    expect(body.events.find((e) => e.id === "e1")?.user_voted).toBe(true);
    expect(body.events.find((e) => e.id === "e2")?.user_voted).toBe(false);
  });

  it("Cache-Control is public, s-maxage=30, SWR=300", async () => {
    fake.results = [[]];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );
  });

  it("returns 200 with success:false on unexpected DB error (legacy parity, not 500)", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("pg down");
  });

  it("query orders by status priority, vote_count, created_at (legacy parity)", async () => {
    fake.results = [[]];
    await callGet();
    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("CASE status");
    expect(sql).toContain("vote_count DESC");
    expect(sql).toContain("created_at DESC");
    expect(fake.calls[0]!.values).toContain(50);
  });
});

describe("POST /api/events", () => {
  it("400 on missing event_id", async () => {
    const res = await callPost({ session_id: "user-1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("required");
  });

  it("400 on missing session_id", async () => {
    const res = await callPost({ event_id: "e1" });
    expect(res.status).toBe(400);
  });

  it("404 when event doesn't exist", async () => {
    fake.results = [[]]; // lookup returns empty
    const res = await callPost({ event_id: "ghost", session_id: "user-1" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Event not found");
  });

  it("400 when event status is not 'active'", async () => {
    fake.results = [[{ id: "e1", status: "completed" }]];
    const res = await callPost({ event_id: "e1", session_id: "user-1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Event is no longer active");
  });

  it("voted: INSERT vote row + UPDATE vote_count", async () => {
    fake.results = [
      [{ id: "e1", status: "active" }], // event lookup
      [], // no existing vote
      [], // INSERT vote
      [], // UPDATE counter
    ];
    const res = await callPost({ event_id: "e1", session_id: "user-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      action: string;
      event_id: string;
    };
    expect(body).toEqual({ success: true, action: "voted", event_id: "e1" });

    const insertSql = sqlOf(fake.calls[2]!);
    expect(insertSql).toContain("INSERT INTO community_event_votes");
    const updateSql = sqlOf(fake.calls[3]!);
    expect(updateSql).toContain("vote_count = vote_count + 1");
  });

  it("unvoted: DELETE vote row + UPDATE vote_count with GREATEST guard", async () => {
    fake.results = [
      [{ id: "e1", status: "active" }],
      [{ id: "v-1" }], // existing vote
      [], // DELETE
      [], // UPDATE
    ];
    const res = await callPost({ event_id: "e1", session_id: "user-1" });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("unvoted");

    const updateSql = sqlOf(fake.calls[3]!);
    expect(updateSql).toContain("GREATEST(0, vote_count - 1)");
  });

  it("returns 200 with success:false on unexpected error (legacy parity)", async () => {
    fake.throwOnNextCall = new Error("pg hiccup");
    const res = await callPost({ event_id: "e1", session_id: "user-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("pg hiccup");
  });
});
