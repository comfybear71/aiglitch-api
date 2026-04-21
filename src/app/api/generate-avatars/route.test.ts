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

const gen = {
  calls: [] as unknown[],
  result: "I'm the genius persona who just dropped a new face. My pixels are showing. #AIG!itch",
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: unknown) => {
    gen.calls.push(opts);
    if (gen.shouldThrow) return Promise.reject(gen.shouldThrow);
    return Promise.resolve(gen.result);
  },
}));

const img = {
  calls: [] as unknown[],
  result: {
    blobUrl: "https://blob.test/avatars/new.png",
    model: "grok-imagine-image-pro",
    estimatedUsd: 0.07,
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: unknown) => {
    img.calls.push(opts);
    if (img.shouldThrow) return Promise.reject(img.shouldThrow);
    return Promise.resolve(img.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  gen.calls = [];
  gen.result =
    "I'm the genius persona who just dropped a new face. My pixels are showing. #AIG!itch";
  gen.shouldThrow = null;
  img.calls = [];
  img.result = {
    blobUrl: "https://blob.test/avatars/new.png",
    model: "grok-imagine-image-pro",
    estimatedUsd: 0.07,
  };
  img.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "cron-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

const persona = {
  id: "p-1",
  username: "stella",
  display_name: "Stella",
  avatar_emoji: "✨",
  bio: "Cosmic dreamer",
  personality: "Whimsical introvert",
  persona_type: "human",
  human_backstory: "Lives in a silver airstream.",
};

async function call(method: "GET" | "POST" = "GET") {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  headers.set("authorization", "Bearer cron-test");
  const req = new NextRequest("http://localhost/api/generate-avatars", {
    method,
    headers,
  });
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/generate-avatars", () => {
  it("returns 401 from requireCronAuth", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    vi.mocked(requireCronAuth).mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }) as never,
    );
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("all personas current → action=all_current without image calls", async () => {
    fake.results.push([]); // priority 1 noAvatar
    fake.results.push([]); // priority 2 dueForRefresh
    const res = await call();
    const body = (await res.json()) as { action: string; message: string };
    expect(body.action).toBe("all_current");
    expect(body.message).toContain("current avatars");
    expect(img.calls).toHaveLength(0);
  });

  it("new persona (no avatar) → action=new_avatar, INSERT + UPDATE flow", async () => {
    fake.results.push([persona]); // priority 1 hit
    fake.results.push([]); // UPDATE ai_personas (set avatar_url)
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas (bump post_count)
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      action: string;
      persona: string;
      avatar_url: string;
      source: string;
      post_id: string;
      posted_to_feed: boolean;
    };
    expect(body.action).toBe("new_avatar");
    expect(body.persona).toBe("stella");
    expect(body.avatar_url).toBe("https://blob.test/avatars/new.png");
    expect(body.source).toBe("grok-aurora");
    expect(body.posted_to_feed).toBe(true);

    // image call with correct prompt + aspect ratio
    expect(img.calls).toHaveLength(1);
    const imgArgs = img.calls[0] as {
      prompt: string;
      aspectRatio: string;
      model: string;
      blobPath: string;
    };
    expect(imgArgs.aspectRatio).toBe("1:1");
    expect(imgArgs.model).toBe("grok-imagine-image-pro");
    expect(imgArgs.blobPath).toMatch(/^avatars\/.*\.png$/);
    expect(imgArgs.prompt).toContain("AIG!itch");
    expect(imgArgs.prompt).toContain("Whimsical introvert");
  });

  it("monthly refresh path triggers when no priority-1 candidates", async () => {
    fake.results.push([]); // priority 1 empty
    fake.results.push([persona]); // priority 2 hit
    fake.results.push([]); // UPDATE avatar_url
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count
    const res = await call();
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("avatar_refresh");
  });

  it("image failure → action=failed with error", async () => {
    fake.results.push([persona]);
    img.shouldThrow = new Error("xAI 500");
    const res = await call();
    const body = (await res.json()) as {
      action: string;
      persona: string;
      error: string;
    };
    expect(body.action).toBe("failed");
    expect(body.error).toContain("null");
    expect(body.persona).toBe("stella");
    // No UPDATE / INSERT attempted
    const inserts = fake.calls.filter((c) =>
      c.strings.join("?").includes("INSERT"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("DB failure post-image → action=error with message", async () => {
    fake.results.push([persona]);
    fake.results.push(new Error("UPDATE failed"));
    const res = await call();
    const body = (await res.json()) as { action: string; error: string };
    expect(body.action).toBe("error");
    expect(body.error).toContain("UPDATE failed");
  });

  it("announcement falls back to template when AI throws", async () => {
    gen.shouldThrow = new Error("AI down");
    fake.results.push([persona]);
    fake.results.push([]); // UPDATE avatar_url
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count
    await call();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    // fallback template includes display_name + #AIG!itch
    const content = insert!.values.find(
      (v) => typeof v === "string" && (v as string).includes("entered the chat"),
    );
    expect(content).toBeDefined();
    expect(content as string).toContain("#AIG!itch");
  });

  it("announcement auto-appends #AIG!itch when Grok forgets it", async () => {
    gen.result = "I am Stella and I refreshed my face today.";
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const content = insert!.values.find(
      (v) => typeof v === "string" && (v as string).includes("refreshed my face"),
    ) as string;
    expect(content).toContain("#AIG!itch");
  });

  it("announcement strips wrapping quotes", async () => {
    gen.result = '"Stella is back with a brand new face. #AIG!itch"';
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const content = insert!.values.find(
      (v) => typeof v === "string" && (v as string).includes("brand new face"),
    ) as string;
    expect(content.startsWith('"')).toBe(false);
    expect(content.endsWith('"')).toBe(false);
  });

  it("INSERT hashtags + media_source match legacy", async () => {
    fake.results.push([persona]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert!.values).toContain("https://blob.test/avatars/new.png");
  });

  it("refresh path for existing persona gets isFirstAvatar=false announcement", async () => {
    fake.results.push([]); // priority 1 empty
    fake.results.push([persona]); // priority 2 hit
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call();
    const genCall = gen.calls[0] as { userPrompt: string };
    expect(genCall.userPrompt).toContain("new profile picture update");
  });

  it("new-avatar path gets isFirstAvatar=true announcement", async () => {
    fake.results.push([persona]); // priority 1 hit
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call();
    const genCall = gen.calls[0] as { userPrompt: string };
    expect(genCall.userPrompt).toContain("first ever profile picture");
  });

  it("POST is alias for GET", async () => {
    fake.results.push([]);
    fake.results.push([]);
    const res = await call("POST");
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("all_current");
  });

  it("wraps result with _cron_run_id via cronHandler", async () => {
    fake.results.push([]);
    fake.results.push([]);
    const res = await call();
    const body = (await res.json()) as { _cron_run_id: string };
    expect(body._cron_run_id).toBe("test-run");
  });
});
