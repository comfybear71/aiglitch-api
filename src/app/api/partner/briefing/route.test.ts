import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

const CONV_ROWS = [
  {
    conversation_id: "conv-1",
    persona_id: "glitch-001",
    display_name: "CH4OS",
    avatar_emoji: "🤖",
    avatar_url: null,
    last_message_at: "2026-04-20T17:00:00Z",
    last_message: "Hey there!",
    last_sender_type: "ai",
  },
];

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGET(query: Record<string, string>) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const qs = new URLSearchParams(query).toString();
  const req = new NextRequest(`http://localhost/api/partner/briefing?${qs}`);
  return GET(req);
}

describe("GET /api/partner/briefing", () => {
  it("400 when session_id missing", async () => {
    const res = await callGET({});
    expect(res.status).toBe(400);
  });

  it("returns briefing data on happy path", async () => {
    fake.results = [
      [{ count: 3 }],   // followed count
      [{ count: 2 }],   // unread notifications
      CONV_ROWS,        // conversations
    ];
    const res = await callGET({ session_id: "sess-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      followed_count: number;
      unread_notifications: number;
      conversations: typeof CONV_ROWS;
    };
    expect(body.followed_count).toBe(3);
    expect(body.unread_notifications).toBe(2);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.last_message).toBe("Hey there!");
  });

  it("returns zeros and empty array when session has no data", async () => {
    fake.results = [
      [{ count: 0 }],  // followed
      [{ count: 0 }],  // notifications
      [],              // conversations
    ];
    const res = await callGET({ session_id: "sess-new" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      followed_count: number;
      unread_notifications: number;
      conversations: unknown[];
    };
    expect(body.followed_count).toBe(0);
    expect(body.unread_notifications).toBe(0);
    expect(body.conversations).toEqual([]);
  });

  it("passes session_id to all queries", async () => {
    fake.results = [[{ count: 0 }], [{ count: 0 }], []];
    await callGET({ session_id: "sess-42" });
    const sessionQueries = fake.calls.filter((c) => c.values.includes("sess-42"));
    expect(sessionQueries.length).toBeGreaterThanOrEqual(3);
  });

  it("sets Cache-Control: private, no-store", async () => {
    fake.results = [[{ count: 0 }], [{ count: 0 }], []];
    const res = await callGET({ session_id: "sess-1" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
