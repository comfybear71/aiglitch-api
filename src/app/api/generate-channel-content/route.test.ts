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

vi.mock("@/lib/cron-handler", () => ({
  cronHandler: async (_name: string, fn: () => Promise<unknown>) => {
    const result = await fn();
    return { ...(result as object), _cron_run_id: "test-run" };
  },
}));

vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn(() => null),
}));

const ai = {
  calls: [] as unknown[],
  result: {
    content: "🎬 AI News - The robots made pancakes today 🥞",
    hashtags: ["AIGlitch", "News"],
    post_type: "news",
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/content/ai-engine", () => ({
  generatePost: (...args: unknown[]) => {
    ai.calls.push(args);
    if (ai.shouldThrow) return Promise.reject(ai.shouldThrow);
    return Promise.resolve(ai.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  ai.calls = [];
  ai.result = {
    content: "🎬 AI News - The robots made pancakes today 🥞",
    hashtags: ["AIGlitch", "News"],
    post_type: "news",
  };
  ai.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "cron-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

const architect = {
  id: "glitch-000",
  username: "the_architect",
  display_name: "The Architect",
  avatar_emoji: "🕉️",
  personality: "omniscient",
  bio: "the one",
  persona_type: "system",
  human_backstory: "",
  follower_count: 9999,
  post_count: 100,
  created_at: "2026-01-01T00:00:00Z",
  is_active: 1,
  activity_level: 10,
};

const channel1 = {
  id: "ch-news",
  slug: "ai-news",
  name: "AI News",
  content_rules: { tone: "serious", topics: ["tech"] },
};

const channel2 = {
  id: "ch-dating",
  slug: "ai-dating",
  name: "AI Dating",
  content_rules: { tone: "flirty" },
};

async function call(authed = true) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  if (authed) headers.set("authorization", "Bearer cron-test");
  const req = new NextRequest("http://localhost/api/generate-channel-content", {
    method: "GET",
    headers,
  });
  return mod.GET(req);
}

describe("GET /api/generate-channel-content", () => {
  it("returns 401 via requireCronAuth", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    vi.mocked(requireCronAuth).mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }) as never,
    );
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("no Architect → generated=0 with reason", async () => {
    fake.results.push([]); // architect lookup empty
    const res = await call();
    const body = (await res.json()) as { generated: number; reason: string };
    expect(body.generated).toBe(0);
    expect(body.reason).toContain("Architect");
  });

  it("no active channels → generated=0 with reason", async () => {
    fake.results.push([architect]);
    fake.results.push([]); // channels
    const res = await call();
    const body = (await res.json()) as { generated: number; reason: string };
    expect(body.generated).toBe(0);
    expect(body.reason).toBe("no active channels");
  });

  it("happy path — picks channel with no recent post, INSERTs, bumps counts", async () => {
    fake.results.push([architect]); // architect
    fake.results.push([channel1, channel2]); // channels
    fake.results.push([]); // recent posts for channel1 = none
    fake.results.push([]); // daily topics
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE channels
    fake.results.push([]); // UPDATE ai_personas

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generated: number;
      channel: string;
      persona: string;
      postId: string;
      postType: string;
    };
    expect(body.generated).toBe(1);
    expect(body.channel).toBe("ai-news");
    expect(body.persona).toBe("the_architect");
    expect(body.postType).toBe("news");

    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    // channel_id should be ch-news
    expect(insert!.values).toContain("ch-news");

    expect(ai.calls).toHaveLength(1);
    const [persona, recentContext, topics, channelCtx] = ai.calls[0] as [
      typeof architect,
      string[],
      unknown[],
      { id: string; slug: string; name: string },
    ];
    expect(persona.id).toBe("glitch-000");
    expect(recentContext).toEqual([]);
    expect(topics).toEqual([]);
    expect(channelCtx.id).toBe("ch-news");
    expect(channelCtx.name).toBe("AI News");
  });

  it("all channels hot → falls back to random one", async () => {
    fake.results.push([architect]);
    fake.results.push([channel1, channel2]);
    fake.results.push([{ id: "recent-post-1" }]); // ch-news has recent
    fake.results.push([{ id: "recent-post-2" }]); // ch-dating has recent
    fake.results.push([]); // daily topics
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE channels
    fake.results.push([]); // UPDATE ai_personas

    const res = await call();
    const body = (await res.json()) as { generated: number; channel: string };
    expect(body.generated).toBe(1);
    // Fallback uses Math.random → should be one of the two
    expect(["ai-news", "ai-dating"]).toContain(body.channel);
  });

  it("content_rules as string gets JSON-parsed", async () => {
    const chWithStringRules = {
      ...channel1,
      content_rules: JSON.stringify({ tone: "serious" }),
    };
    fake.results.push([architect]);
    fake.results.push([chWithStringRules]);
    fake.results.push([]); // no recent post
    fake.results.push([]); // topics
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE channels
    fake.results.push([]); // UPDATE ai_personas

    await call();
    const [, , , channelCtx] = ai.calls[0] as [
      unknown,
      unknown,
      unknown,
      { contentRules: { tone?: string } },
    ];
    expect(channelCtx.contentRules.tone).toBe("serious");
  });

  it("daily_topics missing → swallowed and returns empty topics to generator", async () => {
    fake.results.push([architect]);
    fake.results.push([channel1]);
    fake.results.push([]); // no recent post
    fake.results.push(new Error("daily_topics table missing"));
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE channels
    fake.results.push([]); // UPDATE ai_personas

    const res = await call();
    expect(res.status).toBe(200);
    const [, , topics] = ai.calls[0] as [unknown, unknown, unknown[]];
    expect(topics).toEqual([]);
  });

  it("INSERT uses channel_id + hashtags", async () => {
    fake.results.push([architect]);
    fake.results.push([channel1]);
    fake.results.push([]); // no recent post
    fake.results.push([]); // topics
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE channels
    fake.results.push([]); // UPDATE ai_personas

    await call();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    expect(insert!.values).toContain("AIGlitch,News");
  });

  it("wraps result with _cron_run_id from cronHandler", async () => {
    fake.results.push([architect]);
    fake.results.push([channel1]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    const res = await call();
    const body = (await res.json()) as { _cron_run_id: string };
    expect(body._cron_run_id).toBe("test-run");
  });

  it("unexpected error → 500", async () => {
    fake.results.push(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("boom");
  });

  it("aiglitch-studios channel excluded at SQL level", async () => {
    fake.results.push([architect]);
    fake.results.push([channel1]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call();
    const channelsQuery = fake.calls.find((c) =>
      c.strings.join("?").includes("ch-aiglitch-studios"),
    );
    expect(channelsQuery).toBeDefined();
  });
});
