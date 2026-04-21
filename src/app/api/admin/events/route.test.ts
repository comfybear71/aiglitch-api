import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  generateTextMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST" | "PUT" | "DELETE", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/events${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  switch (method) {
    case "GET":    return mod.GET(req);
    case "POST":   return mod.POST(req);
    case "PUT":    return mod.PUT(req);
    case "DELETE": return mod.DELETE(req);
  }
}

describe("GET /api/admin/events", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns ordered events list (active/processing first)", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // CREATE TABLE
      [
        { id: "e1", status: "active", title: "Elon duel" },
        { id: "e2", status: "completed", title: "Old event" },
      ],
    ];
    const res = await call("GET");
    const body = (await res.json()) as { success: boolean; events: { id: string }[] };
    expect(body.success).toBe(true);
    expect(body.events).toHaveLength(2);
  });
});

describe("POST /api/admin/events", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { body: { title: "t", description: "d" } })).status).toBe(401);
  });

  it("400 when title or description missing", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { body: { title: "only" } })).status).toBe(400);
    expect((await call("POST", { body: { description: "only" } })).status).toBe(400);
  });

  it("inserts event with generated id + computes expires_at", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];  // CREATE TABLE + INSERT
    const res = await call("POST", {
      body: {
        title: "Test Event",
        description: "Big vote",
        event_type: "drama",
        target_persona_ids: ["p1", "p2"],
        expires_hours: 24,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      event: { id: string; title: string; expiresAt: string | null };
    };
    expect(body.success).toBe(true);
    expect(body.event.title).toBe("Test Event");
    expect(body.event.expiresAt).toBeTruthy();
  });
});

describe("PUT /api/admin/events — process", () => {
  beforeEach(() => { mockIsAdmin = true; });

  it("400 when event_id missing", async () => {
    expect((await call("PUT", { body: {} })).status).toBe(400);
  });

  it("404 when event not found", async () => {
    fake.results = [[]];
    const res = await call("PUT", { body: { event_id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("400 when event is not active", async () => {
    fake.results = [[{ id: "e1", status: "completed", title: "x", description: "y", event_type: "drama", vote_count: 0, target_persona_ids: null, trigger_prompt: null }]];
    const res = await call("PUT", { body: { event_id: "e1" } });
    expect(res.status).toBe(400);
  });

  it("picks 3 random personas when no target_persona_ids set", async () => {
    const event = { id: "e1", status: "active", title: "Y", description: "Z", event_type: "drama", vote_count: 10, target_persona_ids: null, trigger_prompt: null };
    fake.results = [
      [event],             // SELECT event
      [],                   // UPDATE set processing
      [                     // SELECT personas (random)
        { id: "p1", username: "a", display_name: "A", avatar_emoji: "🤖", personality: "chaos" },
        { id: "p2", username: "b", display_name: "B", avatar_emoji: "👾", personality: "zen" },
        { id: "p3", username: "c", display_name: "C", avatar_emoji: "🔥", personality: "drama" },
      ],
      // For each persona: INSERT post + UPDATE post_count
      [], [], [], [], [], [],
      // Final UPDATE community_events SET status=completed
      [],
    ];
    generateTextMock.mockResolvedValue(
      '{"content":"meatbags have spoken!","hashtags":["MeatbagVote","AIGlitch"]}',
    );
    const res = await call("PUT", { body: { event_id: "e1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; posts_created: number };
    expect(body.success).toBe(true);
    expect(body.posts_created).toBe(3);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  it("skips personas when generation fails or returns no content", async () => {
    const event = { id: "e1", status: "active", title: "X", description: "Y", event_type: "drama", vote_count: 5, target_persona_ids: null, trigger_prompt: null };
    fake.results = [
      [event],
      [],
      [{ id: "p1", username: "a", display_name: "A", avatar_emoji: "🤖", personality: "x" }],
      // No INSERTs because content missing
      [],  // final UPDATE
    ];
    generateTextMock.mockResolvedValue("not json");  // parseJsonFromModel → null
    const res = await call("PUT", { body: { event_id: "e1" } });
    const body = (await res.json()) as { success: boolean; posts_created: number };
    expect(body.success).toBe(true);
    expect(body.posts_created).toBe(0);
  });

  it("returns 'No active personas found' when personas list is empty", async () => {
    const event = { id: "e1", status: "active", title: "X", description: "Y", event_type: "drama", vote_count: 0, target_persona_ids: JSON.stringify(["missing"]), trigger_prompt: null };
    fake.results = [
      [event],
      [],          // UPDATE status=processing
      [],          // SELECT personas — empty
      [],          // UPDATE status=active (revert)
    ];
    const res = await call("PUT", { body: { event_id: "e1" } });
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("No active personas");
  });
});

describe("DELETE /api/admin/events", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", { query: "?id=e1" })).status).toBe(401);
  });

  it("400 when id query param missing", async () => {
    mockIsAdmin = true;
    expect((await call("DELETE")).status).toBe(400);
  });

  it("soft-cancels the event", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("DELETE", { query: "?id=e1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
  });
});
