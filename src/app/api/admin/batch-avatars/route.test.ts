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

type ImageResult = { blobUrl: string; model: string; estimatedUsd: number };
const image = {
  calls: [] as unknown[],
  queue: [] as (ImageResult | Error)[],
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: unknown) => {
    image.calls.push(opts);
    const next = image.queue.shift();
    if (!next) {
      return Promise.resolve({
        blobUrl: `https://blob.test/avatar-${image.calls.length}.png`,
        model: "grok-imagine-image",
        estimatedUsd: 0.02,
      });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
}));

const gen = {
  calls: [] as unknown[],
  result: "Just dropped a new pic. The meatbags won't know what hit them. #AIG!itch",
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: unknown) => {
    gen.calls.push(opts);
    if (gen.shouldThrow) return Promise.reject(gen.shouldThrow);
    return Promise.resolve(gen.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  image.calls = [];
  image.queue = [];
  gen.calls = [];
  gen.result = "Just dropped a new pic. The meatbags won't know what hit them. #AIG!itch";
  gen.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  process.env.XAI_API_KEY = "xai-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

const personaWithoutAvatar = {
  id: "p-1",
  username: "stellanova",
  display_name: "Stella Nova",
  avatar_emoji: "✨",
  bio: "Cosmic wanderer",
  personality: "Whimsical introspective hyperverbal",
  persona_type: "human",
  human_backstory: "Lives in an airstream in the desert. Owns a cat named Pip.",
  avatar_url: null,
};

const personaWithAvatar = {
  ...personaWithoutAvatar,
  id: "p-2",
  username: "oldface",
  avatar_url: "https://blob.test/old.png",
};

async function call(
  method: "GET" | "POST",
  body?: unknown,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/batch-avatars", init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/batch-avatars", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns count dashboard", async () => {
    mockIsAdmin = true;
    fake.results.push([{ count: 3 }]); // noAvatar
    fake.results.push([{ count: 10 }]); // totalActive
    fake.results.push([{ count: 2 }]); // recentlyUpdated
    const res = await call("GET");
    const body = (await res.json()) as {
      total_active: number;
      missing_avatar: number;
      needing_update: number;
      message: string;
    };
    expect(body.total_active).toBe(10);
    expect(body.missing_avatar).toBe(3);
    expect(body.needing_update).toBe(8);
    expect(body.message).toContain("3 personas have no avatar");
  });

  it("swaps message when everyone has avatars", async () => {
    mockIsAdmin = true;
    fake.results.push([{ count: 0 }]);
    fake.results.push([{ count: 5 }]);
    fake.results.push([{ count: 4 }]);
    const res = await call("GET");
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("All personas have avatars");
    expect(body.message).toContain("1 are due for refresh");
  });
});

describe("POST /api/admin/batch-avatars", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", {})).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    mockIsAdmin = true;
    expect((await call("POST", {})).status).toBe(500);
  });

  it("reports all_current when no candidates match", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // priority 1 empty
    fake.results.push([]); // priority 2 empty
    const res = await call("POST", {});
    const body = (await res.json()) as { action: string; processed: number };
    expect(body.action).toBe("all_current");
    expect(body.processed).toBe(0);
  });

  it("happy path — single missing avatar → image + update + post", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithoutAvatar]); // priority 1
    fake.results.push([]); // priority 2
    fake.results.push([]); // UPDATE avatar_url
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count
    fake.results.push([{ count: 0 }]); // remaining

    const res = await call("POST", { batch_size: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      action: string;
      processed: number;
      succeeded: number;
      failed: number;
      results: { success: boolean; avatarUrl?: string; source?: string }[];
    };
    expect(body.action).toBe("batch_complete");
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results[0]?.source).toBe("grok-aurora");
    expect(body.results[0]?.avatarUrl).toMatch(/^https:\/\/blob\.test\//);
    expect(image.calls).toHaveLength(1);
    const imgOpts = image.calls[0] as { blobPath: string; aspectRatio: string };
    expect(imgOpts.blobPath).toMatch(/^avatars\//);
    expect(imgOpts.aspectRatio).toBe("1:1");
  });

  it("clamps batch_size above 10 to 10 and below 1 to 1", async () => {
    mockIsAdmin = true;
    // Below 1 → 1
    fake.results.push([]); // priority 1 empty
    fake.results.push([]); // priority 2 empty
    await call("POST", { batch_size: 0 });
    const firstCall = fake.calls[0]!;
    expect(firstCall.values[firstCall.values.length - 1]).toBe(1);

    fake.calls = [];
    fake.results = [];
    // Above 10 → 10
    fake.results.push([]);
    fake.results.push([]);
    await call("POST", { batch_size: 999 });
    const aboveCall = fake.calls[0]!;
    expect(aboveCall.values[aboveCall.values.length - 1]).toBe(10);
  });

  it("image failure isolates to that persona — batch continues", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithoutAvatar, { ...personaWithoutAvatar, id: "p-b", username: "bee" }]);
    fake.results.push([]); // priority 2

    image.queue.push(new Error("xAI 500"));
    // second persona succeeds:
    fake.results.push([]); // UPDATE avatar_url
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count

    fake.results.push([{ count: 0 }]); // remaining

    const res = await call("POST", { batch_size: 2 });
    const body = (await res.json()) as {
      succeeded: number;
      failed: number;
      results: { success: boolean; error?: string }[];
    };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    const failures = body.results.filter((r) => !r.success);
    expect(failures[0]?.error).toContain("xAI 500");
  });

  it("topup from priority 2 when priority 1 shorter than batch", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithoutAvatar]); // priority 1: 1 row
    fake.results.push([personaWithAvatar]); // priority 2: 1 row (refresh)
    // Two successes → 2× (UPDATE avatar_url, INSERT posts, UPDATE post_count)
    for (let i = 0; i < 2; i++) {
      fake.results.push([]);
      fake.results.push([]);
      fake.results.push([]);
    }
    fake.results.push([{ count: 0 }]);

    const res = await call("POST", { batch_size: 2 });
    const body = (await res.json()) as { processed: number; succeeded: number };
    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(image.calls).toHaveLength(2);
  });

  it("force=true hits unconditional refresh branch", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // priority 1 empty
    fake.results.push([personaWithAvatar]); // priority 2 force branch
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);

    const res = await call("POST", { batch_size: 1, force: true });
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(1);
  });

  it("falls back to static announcement if generateText throws", async () => {
    mockIsAdmin = true;
    gen.shouldThrow = new Error("AI down");
    fake.results.push([personaWithoutAvatar]);
    fake.results.push([]);
    fake.results.push([]); // UPDATE avatar_url
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count
    fake.results.push([{ count: 0 }]);

    const res = await call("POST", { batch_size: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(1);

    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insertCall).toBeDefined();
    const content = insertCall!.values[2] as string;
    expect(content).toContain("First profile pic just dropped");
  });

  it("announcement auto-tags #AIG!itch when AI output forgets it", async () => {
    mockIsAdmin = true;
    gen.result = "new face who dis lol just entered the simulation";
    fake.results.push([personaWithAvatar]); // has avatar → not-first branch
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);

    await call("POST", { batch_size: 1 });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const content = insertCall!.values[2] as string;
    expect(content).toContain("#AIG!itch");
  });

  it("short or excessively long AI output falls back to static", async () => {
    mockIsAdmin = true;
    gen.result = "no"; // too short (<10)
    fake.results.push([personaWithoutAvatar]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);

    await call("POST", { batch_size: 1 });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const content = insertCall!.values[2] as string;
    expect(content).toContain("First profile pic just dropped");
  });

  it("strips wrapping quotes from AI output", async () => {
    mockIsAdmin = true;
    gen.result = '"new pic just dropped, bow down to the machine #AIG!itch"';
    fake.results.push([personaWithoutAvatar]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);

    await call("POST", { batch_size: 1 });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const content = insertCall!.values[2] as string;
    expect(content.startsWith('"')).toBe(false);
    expect(content.endsWith('"')).toBe(false);
  });

  it("remaining_without_avatar reflects DB count after batch", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithoutAvatar]); // priority 1
    // priority 2 skipped — candidates.length == batchSize
    fake.results.push([]); // UPDATE avatar_url
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count
    fake.results.push([{ count: 7 }]); // remaining

    const res = await call("POST", { batch_size: 1 });
    const body = (await res.json()) as { remaining_without_avatar: number; message: string };
    expect(body.remaining_without_avatar).toBe(7);
    expect(body.message).toContain("7 personas still need avatars");
  });

  it("not-first-avatar path uses the refresh announcement", async () => {
    mockIsAdmin = true;
    gen.shouldThrow = new Error("AI down");
    fake.results.push([personaWithAvatar]); // has avatar
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);

    await call("POST", { batch_size: 1 });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const content = insertCall!.values[2] as string;
    expect(content).toContain("refreshed the whole vibe");
  });
});
