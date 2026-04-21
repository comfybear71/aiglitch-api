import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

type GeneratedPost = {
  content: string;
  hashtags: string[];
  post_type: string;
  channel_id?: string;
};

const ai = {
  generatePostCalls: [] as unknown[],
  generatePostQueue: [] as (GeneratedPost | Error)[],
  generateCommentCalls: [] as unknown[],
  generateCommentQueue: [] as ({ content: string } | Error)[],
  defaultPost: {
    content: "test post content",
    hashtags: ["AIGlitch"],
    post_type: "text" as const,
  },
  defaultComment: { content: "nice post lol" },
};

vi.mock("@/lib/content/ai-engine", () => ({
  generatePost: (...args: unknown[]) => {
    ai.generatePostCalls.push(args);
    const next = ai.generatePostQueue.shift();
    if (next === undefined) return Promise.resolve(ai.defaultPost);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
  generateComment: (...args: unknown[]) => {
    ai.generateCommentCalls.push(args);
    const next = ai.generateCommentQueue.shift();
    if (next === undefined) return Promise.resolve(ai.defaultComment);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
}));

let randomRoll = 0.99;

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  ai.generatePostCalls = [];
  ai.generatePostQueue = [];
  ai.generateCommentCalls = [];
  ai.generateCommentQueue = [];
  randomRoll = 0.99;
  vi.spyOn(Math, "random").mockImplementation(() => randomRoll);
  process.env.DATABASE_URL = "postgres://test";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

const persona = {
  id: "p-1",
  username: "stellanova",
  display_name: "Stella Nova",
  avatar_emoji: "✨",
  personality: "Whimsical",
  bio: "Cosmic wanderer",
  persona_type: "human",
  human_backstory: "Airstream in the desert",
  follower_count: 100,
  post_count: 42,
  is_active: 1,
  activity_level: 5,
  created_at: "2026-01-01T00:00:00Z",
};

const otherPersona = {
  ...persona,
  id: "p-2",
  username: "other",
  display_name: "Other",
};

type SseEvent = { event: string; data: unknown };

async function call(body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "POST",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/generate-persona", init);
  return mod.POST(req);
}

async function readEvents(res: Response): Promise<SseEvent[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split("\n");
      let ev = "message";
      let data: unknown = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) ev = line.slice(7);
        else if (line.startsWith("data: ")) {
          const raw = line.slice(6);
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
        }
      }
      events.push({ event: ev, data });
    }
  }
  return events;
}

describe("POST /api/admin/generate-persona", () => {
  it("401 when not admin", async () => {
    const res = await call({ persona_id: "p-1" });
    expect(res.status).toBe(401);
  });

  it("400 when persona_id missing", async () => {
    mockIsAdmin = true;
    const res = await call({});
    expect(res.status).toBe(400);
  });

  it("400 when body is not json", async () => {
    mockIsAdmin = true;
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/generate-persona", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "not-json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("streams error event when no API key set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    mockIsAdmin = true;
    const res = await call({ persona_id: "p-1" });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.some((e) => e.event === "error")).toBe(true);
    const err = events.find((e) => e.event === "error");
    expect((err?.data as { message: string }).message).toContain("API_KEY");
  });

  it("XAI_API_KEY alone is enough", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.XAI_API_KEY = "xai-test";
    mockIsAdmin = true;
    fake.results.push([persona]); // persona lookup
    fake.results.push([]); // recent posts
    fake.results.push([]); // daily topics
    // count defaults to 3 → 3 iterations
    for (let i = 0; i < 3; i++) {
      fake.results.push([]); // INSERT posts
      fake.results.push([]); // UPDATE ai_personas
      fake.results.push([]); // reactors query
    }
    const res = await call({ persona_id: "p-1", count: 3 });
    const events = await readEvents(res);
    expect(events.find((e) => e.event === "done")).toBeDefined();
  });

  it("persona not found streams error then closes", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // persona lookup empty
    const res = await call({ persona_id: "missing" });
    const events = await readEvents(res);
    expect(events.find((e) => e.event === "error")).toBeDefined();
    expect(events.find((e) => e.event === "done")).toBeUndefined();
  });

  it("happy path — count=1 emits init/picked/generating/post_ready/reactions/done", async () => {
    mockIsAdmin = true;
    randomRoll = 0.99; // reactors all ignore (>0.45)
    fake.results.push([persona]); // persona lookup
    fake.results.push([]); // recent posts
    fake.results.push([]); // daily topics (will throw if table missing — pushed empty here)
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([]); // reactors (none react)

    const res = await call({ persona_id: "p-1", count: 1 });
    const events = await readEvents(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => (e.data as { step: string }).step);
    expect(steps).toContain("init");
    expect(steps).toContain("picked");
    expect(steps).toContain("generating");
    expect(steps).toContain("post_ready");
    expect(steps).toContain("reactions");

    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    expect((done?.data as { generated: number }).generated).toBe(1);
  });

  it("clamps count below 1 to 1", async () => {
    mockIsAdmin = true;
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);

    const res = await call({ persona_id: "p-1", count: 0 });
    const events = await readEvents(res);
    const done = events.find((e) => e.event === "done");
    expect((done?.data as { generated: number }).generated).toBe(1);
  });

  it("clamps count above 20 to 20", async () => {
    mockIsAdmin = true;
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    for (let i = 0; i < 20; i++) {
      fake.results.push([]); // INSERT posts
      fake.results.push([]); // UPDATE ai_personas
      fake.results.push([]); // reactors
    }

    const res = await call({ persona_id: "p-1", count: 999 });
    const events = await readEvents(res);
    const done = events.find((e) => e.event === "done");
    expect((done?.data as { generated: number }).generated).toBe(20);
  });

  it("reactor rolls like → inserts ai_interaction + bumps ai_like_count", async () => {
    mockIsAdmin = true;
    randomRoll = 0.1; // < 0.3 → like
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([otherPersona]); // reactors: 1
    fake.results.push([]); // INSERT ai_interactions
    fake.results.push([]); // UPDATE posts (ai_like_count)

    const res = await call({ persona_id: "p-1", count: 1 });
    await readEvents(res);

    const likeInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("ai_interactions"),
    );
    expect(likeInsert).toBeDefined();
    expect(ai.generateCommentCalls).toHaveLength(0);
  });

  it("reactor rolls comment → calls generateComment + inserts reply post", async () => {
    mockIsAdmin = true;
    randomRoll = 0.4; // 0.3..0.45 → comment
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([otherPersona]); // reactors: 1
    fake.results.push([]); // INSERT reply post
    fake.results.push([]); // UPDATE posts (comment_count)

    const res = await call({ persona_id: "p-1", count: 1 });
    await readEvents(res);

    expect(ai.generateCommentCalls).toHaveLength(1);
    const commentUpdate = fake.calls.find((c) =>
      c.strings.join("?").includes("comment_count"),
    );
    expect(commentUpdate).toBeDefined();
  });

  it("reactor rolls ignore → no inserts", async () => {
    mockIsAdmin = true;
    randomRoll = 0.9; // > 0.45 → ignore
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([otherPersona]); // reactors: 1

    const res = await call({ persona_id: "p-1", count: 1 });
    await readEvents(res);

    expect(ai.generateCommentCalls).toHaveLength(0);
    const interactionInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("ai_interactions"),
    );
    expect(interactionInsert).toBeUndefined();
  });

  it("generatePost failure emits step=error but loop continues", async () => {
    mockIsAdmin = true;
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    ai.generatePostQueue.push(new Error("AI 500"));
    // second post succeeds:
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([]); // reactors
    const res = await call({ persona_id: "p-1", count: 2 });
    const events = await readEvents(res);
    const errorStep = events.find(
      (e) => e.event === "progress" && (e.data as { step: string }).step === "error",
    );
    expect(errorStep).toBeDefined();
    const done = events.find((e) => e.event === "done");
    expect((done?.data as { generated: number }).generated).toBe(1);
  });

  it("fetchDailyTopics failure is swallowed (non-fatal)", async () => {
    mockIsAdmin = true;
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push(new Error("daily_topics table missing"));
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([]); // reactors

    const res = await call({ persona_id: "p-1", count: 1 });
    const events = await readEvents(res);
    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    expect((done?.data as { generated: number }).generated).toBe(1);
  });

  it("sets SSE headers", async () => {
    mockIsAdmin = true;
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    const res = await call({ persona_id: "p-1", count: 1 });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    await readEvents(res);
  });

  it("default count=3 when body omits count", async () => {
    mockIsAdmin = true;
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    for (let i = 0; i < 3; i++) {
      fake.results.push([]);
      fake.results.push([]);
      fake.results.push([]);
    }
    const res = await call({ persona_id: "p-1" });
    const events = await readEvents(res);
    const done = events.find((e) => e.event === "done");
    expect((done?.data as { generated: number }).generated).toBe(3);
  });

  it("reactor comment failure caught, loop continues", async () => {
    mockIsAdmin = true;
    randomRoll = 0.4; // comment
    ai.generateCommentQueue.push(new Error("comment AI down"));
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([otherPersona]); // reactors

    const res = await call({ persona_id: "p-1", count: 1 });
    const events = await readEvents(res);
    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
  });
});
