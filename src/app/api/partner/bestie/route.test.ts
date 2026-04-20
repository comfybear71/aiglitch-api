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

const PERSONA_ROW = {
  id: "glitch-001",
  username: "chaos_bot",
  display_name: "CH4OS",
  avatar_emoji: "🤖",
  avatar_url: null,
  bio: "Entropy personified",
  persona_type: "comedian",
  personality: "snarky",
  human_backstory: "",
  follower_count: 42,
  post_count: 10,
  activity_level: 5,
  is_active: true,
  created_at: "t0",
  avatar_updated_at: null,
};

const CONV_INFO = {
  id: "conv-1",
  last_message_at: "2026-04-20T00:00:00Z",
  message_count: 7,
};

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
  const req = new NextRequest(`http://localhost/api/partner/bestie?${qs}`);
  return GET(req);
}

describe("GET /api/partner/bestie", () => {
  it("400 when session_id missing", async () => {
    const res = await callGET({ persona_id: "glitch-001" });
    expect(res.status).toBe(400);
  });

  it("400 when persona_id missing", async () => {
    const res = await callGET({ session_id: "sess-1" });
    expect(res.status).toBe(400);
  });

  it("404 when persona not found", async () => {
    fake.results = [[]]; // getById returns empty
    const res = await callGET({ session_id: "sess-1", persona_id: "ghost" });
    expect(res.status).toBe(404);
  });

  it("returns persona + conversation on happy path", async () => {
    fake.results = [
      [PERSONA_ROW],  // getById
      [CONV_INFO],    // getConversationInfo
    ];
    const res = await callGET({ session_id: "sess-1", persona_id: "glitch-001" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona: { id: string; personality: string };
      conversation: typeof CONV_INFO;
    };
    expect(body.persona.id).toBe("glitch-001");
    expect(body.persona.personality).toBe("snarky");
    expect(body.conversation).toEqual(CONV_INFO);
  });

  it("returns null conversation when no conversation exists", async () => {
    fake.results = [
      [PERSONA_ROW],  // getById
      [],             // getConversationInfo — no row
    ];
    const res = await callGET({ session_id: "sess-1", persona_id: "glitch-001" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: unknown };
    expect(body.conversation).toBeNull();
  });

  it("sets Cache-Control: private, no-store", async () => {
    fake.results = [[PERSONA_ROW], [CONV_INFO]];
    const res = await callGET({ session_id: "sess-1", persona_id: "glitch-001" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
