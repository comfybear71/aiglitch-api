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

const imageGen = {
  calls: [] as { prompt: string; blobPath: string; model?: string; aspectRatio?: string }[],
  result: {
    blobUrl: "https://blob.test/avatars/generated.png",
    model: "grok-imagine-image-pro" as const,
    estimatedUsd: 0.07,
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: {
    prompt: string;
    blobPath: string;
    model?: string;
    aspectRatio?: string;
  }) => {
    imageGen.calls.push(opts);
    if (imageGen.shouldThrow) return Promise.reject(imageGen.shouldThrow);
    return Promise.resolve(imageGen.result);
  },
}));

const textGen = {
  calls: [] as { systemPrompt?: string; userPrompt: string; taskType: string }[],
  result: "Fresh pixels, fresh vibes. #AIG!itch",
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: { systemPrompt?: string; userPrompt: string; taskType: string }) => {
    textGen.calls.push(opts);
    if (textGen.shouldThrow) return Promise.reject(textGen.shouldThrow);
    return Promise.resolve(textGen.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  imageGen.calls = [];
  imageGen.result = {
    blobUrl: "https://blob.test/avatars/generated.png",
    model: "grok-imagine-image-pro",
    estimatedUsd: 0.07,
  };
  imageGen.shouldThrow = null;
  textGen.calls = [];
  textGen.result = "Fresh pixels, fresh vibes. #AIG!itch";
  textGen.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method: "POST" };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/persona-avatar", init);
  return mod.POST(req);
}

const samplePersona = {
  id: "glitch-hat",
  username: "glitchhat",
  display_name: "Glitch Hat",
  avatar_emoji: "🎩",
  bio: "A hat that glitches.",
  personality: "enigmatic and dapper",
  persona_type: "accessory",
  human_backstory: "Forged in a haunted haberdashery.",
  avatar_url: null,
};

describe("POST /api/admin/persona-avatar — auth + validation", () => {
  it("401 when not admin", async () => {
    expect((await call({ persona_id: "glitch-hat" })).status).toBe(401);
  });

  it("400 when persona_id missing", async () => {
    mockIsAdmin = true;
    const res = await call({});
    expect(res.status).toBe(400);
    expect(imageGen.calls).toHaveLength(0);
  });

  it("404 when persona not found", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // SELECT returns no rows
    const res = await call({ persona_id: "ghost" });
    expect(res.status).toBe(404);
    expect(imageGen.calls).toHaveLength(0);
  });
});

describe("POST /api/admin/persona-avatar — happy path", () => {
  it("generates avatar, updates persona, posts to feed by default", async () => {
    mockIsAdmin = true;
    fake.results.push([samplePersona]); // SELECT persona
    fake.results.push([]); // UPDATE avatar
    fake.results.push([]); // INSERT post
    fake.results.push([]); // UPDATE post_count

    const res = await call({ persona_id: "glitch-hat" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      avatar_url: string;
      source: string;
      posted_to_feed: boolean;
      post_id: string;
      admin_override: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.avatar_url).toBe("https://blob.test/avatars/generated.png");
    expect(body.source).toBe("grok-aurora");
    expect(body.posted_to_feed).toBe(true);
    expect(body.post_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.admin_override).toBe(true);

    expect(imageGen.calls).toHaveLength(1);
    const genCall = imageGen.calls[0]!;
    expect(genCall.model).toBe("grok-imagine-image-pro");
    expect(genCall.aspectRatio).toBe("1:1");
    expect(genCall.blobPath).toMatch(/^avatars\/[0-9a-f-]{36}\.png$/i);
    expect(genCall.prompt).toContain("enigmatic and dapper");
    expect(genCall.prompt).toContain("AIG!itch");

    const update = fake.calls[1]!; // SELECT, UPDATE, INSERT, UPDATE
    expect(update.strings.join("?")).toContain("UPDATE ai_personas");
    expect(update.strings.join("?")).toContain("avatar_url");
    expect(update.values).toContain("https://blob.test/avatars/generated.png");

    const insert = fake.calls[2]!;
    expect(insert.strings.join("?")).toContain("INSERT INTO posts");

    const counter = fake.calls[3]!;
    expect(counter.strings.join("?")).toContain("SET post_count = post_count + 1");
  });

  it("skips the feed post when post_to_feed=false", async () => {
    mockIsAdmin = true;
    fake.results.push([samplePersona]);
    fake.results.push([]); // UPDATE avatar
    const res = await call({ persona_id: "glitch-hat", post_to_feed: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posted_to_feed: boolean; post_id: string | null };
    expect(body.posted_to_feed).toBe(false);
    expect(body.post_id).toBeNull();
    // Only 2 SQL calls: SELECT + UPDATE. No INSERT posts.
    expect(fake.calls).toHaveLength(2);
    expect(textGen.calls).toHaveLength(0);
  });

  it("uses the first-avatar template when announcement text fails and no prior avatar_url", async () => {
    mockIsAdmin = true;
    fake.results.push([samplePersona]); // avatar_url is null
    fake.results.push([]); // UPDATE
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE count
    textGen.shouldThrow = new Error("text gen down");
    const res = await call({ persona_id: "glitch-hat" });
    expect(res.status).toBe(200);
    const insert = fake.calls[2]!;
    const postContent = insert.values[2] as string;
    expect(postContent).toContain("has entered the chat");
    expect(postContent).toContain("#AIG!itch");
  });

  it("uses the update-avatar template when announcement fails and prior avatar_url exists", async () => {
    mockIsAdmin = true;
    fake.results.push([{ ...samplePersona, avatar_url: "https://blob.test/old.png" }]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    textGen.shouldThrow = new Error("text gen down");
    const res = await call({ persona_id: "glitch-hat" });
    expect(res.status).toBe(200);
    const insert = fake.calls[2]!;
    const postContent = insert.values[2] as string;
    expect(postContent).toContain("just refreshed the whole vibe");
  });

  it("appends #AIG!itch when the AI text omits it", async () => {
    mockIsAdmin = true;
    fake.results.push([samplePersona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    textGen.result = "Behold, I have a face now and the universe trembles.";
    await call({ persona_id: "glitch-hat" });
    const insert = fake.calls[2]!;
    const postContent = insert.values[2] as string;
    expect(postContent.endsWith("#AIG!itch")).toBe(true);
  });
});

describe("POST /api/admin/persona-avatar — image-gen failure", () => {
  it("returns 500 and does not touch ai_personas when the helper throws", async () => {
    mockIsAdmin = true;
    fake.results.push([samplePersona]); // SELECT succeeds
    imageGen.shouldThrow = new Error("xAI upstream failed");
    const res = await call({ persona_id: "glitch-hat" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Generation failed");
    const hadUpdate = fake.calls.some((c) =>
      c.strings.join("?").includes("UPDATE ai_personas"),
    );
    expect(hadUpdate).toBe(false);
  });
});
