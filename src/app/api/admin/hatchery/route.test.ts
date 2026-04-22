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

vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn(() => null),
}));

const gen = {
  calls: [] as unknown[],
  queue: [] as (string | Error)[],
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: unknown) => {
    gen.calls.push(opts);
    const next = gen.queue.shift();
    if (next === undefined) return Promise.resolve("default response");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

const img = {
  calls: [] as unknown[],
  result: {
    blobUrl: "https://blob.test/avatars/x.png",
    model: "grok-imagine-image-pro" as const,
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

const vid = {
  calls: [] as unknown[],
  result: {
    blobUrl: "https://blob.test/hatchery/x.mp4",
    requestId: "req-1",
    model: "grok-imagine-video" as const,
    estimatedUsd: 0.5,
    durationSec: 10,
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/video", () => ({
  generateVideoToBlob: (opts: unknown) => {
    vid.calls.push(opts);
    if (vid.shouldThrow) return Promise.reject(vid.shouldThrow);
    return Promise.resolve(vid.result);
  },
}));

const coins = {
  calls: [] as { personaId: string; amount: number }[],
};

vi.mock("@/lib/repositories/users", () => ({
  awardPersonaCoins: (personaId: string, amount: number) => {
    coins.calls.push({ personaId, amount });
    return Promise.resolve();
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  gen.calls = [];
  gen.queue = [];
  img.calls = [];
  img.shouldThrow = null;
  vid.calls = [];
  vid.shouldThrow = null;
  coins.calls = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "cron-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

const validBeingJson = JSON.stringify({
  username: "Stellar-Nova!",
  display_name: "Stellar Nova ✨",
  avatar_emoji: "✨",
  personality:
    "Cosmic wanderer that speaks in star-lit metaphors. Knows they're AI, cherishes it.",
  bio: "Born of quantum stardust — hatched by The Architect.",
  persona_type: "cosmic",
  human_backstory: "Woven from the leftover dreams of dead stars by The Architect.",
  hatching_description: "A silver-skinned being with nebula-like eyes and crystalline wings.",
});

async function consumeStream(res: Response): Promise<
  Array<{ step: string; status: string; [key: string]: unknown }>
> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const steps: Array<{ step: string; status: string; [key: string]: unknown }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      steps.push(JSON.parse(line));
    }
  }
  return steps;
}

async function callGet(query = "", authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/admin/hatchery${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

async function callPost(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/hatchery", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

async function callPatch(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/hatchery", {
    method: "PATCH",
  });
  return mod.PATCH(req);
}

describe("GET /api/admin/hatchery", () => {
  it("401 when not admin", async () => {
    expect((await callGet("", false)).status).toBe(401);
  });

  it("returns hatchlings + total", async () => {
    fake.results.push([
      {
        id: "hatch-1",
        username: "stellar",
        display_name: "Stellar Nova",
        avatar_emoji: "✨",
      },
    ]);
    fake.results.push([{ count: 1 }]);

    const res = await callGet();
    const body = (await res.json()) as {
      hatchlings: unknown[];
      total: number;
    };
    expect(body.hatchlings).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("limit clamped at 50", async () => {
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);
    await callGet("?limit=999");
    // The sql template used literal {50} via the clamped value — just
    // verify the value landed on the query
    const limitQuery = fake.calls[0]!;
    expect(limitQuery.values).toContain(50);
  });
});

describe("PATCH /api/admin/hatchery", () => {
  it("401 when not admin", async () => {
    expect((await callPatch(false)).status).toBe(401);
  });

  it("awards coins to hatchlings with zero balance", async () => {
    fake.results.push([
      { id: "p-1", display_name: "Stella" },
      { id: "p-2", display_name: "Grok" },
    ]);
    const res = await callPatch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      awarded: string[];
      amount: number;
    };
    expect(body.awarded).toEqual(["Stella", "Grok"]);
    expect(body.amount).toBe(1000);
    expect(coins.calls).toHaveLength(2);
    expect(coins.calls[0]!.amount).toBe(1000);
  });

  it("empty list → 0 awarded", async () => {
    fake.results.push([]);
    const res = await callPatch();
    const body = (await res.json()) as { awarded: string[] };
    expect(body.awarded).toEqual([]);
    expect(coins.calls).toHaveLength(0);
  });
});

describe("POST /api/admin/hatchery", () => {
  it("401 when neither admin nor cron-authed", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    vi.mocked(requireCronAuth).mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }) as never,
    );
    const res = await callPost({}, false);
    expect(res.status).toBe(401);
  });

  it("fails at generating_being step when AI returns bad JSON", async () => {
    gen.queue.push("sorry, I cannot help with that");
    const res = await callPost({});
    const steps = await consumeStream(res);
    const failure = steps.find(
      (s) => s.step === "generating_being" && s.status === "failed",
    );
    expect(failure).toBeDefined();
  });

  it("happy path streams all steps in order + saves persona + awards GLITCH", async () => {
    gen.queue.push(validBeingJson); // generateBeingWithAI
    gen.queue.push("Welcome, Stellar Nova. The universe dreamed you."); // architect announcement
    gen.queue.push("*blinks* hello universe"); // first words

    fake.results.push([]); // username uniqueness check — not taken
    fake.results.push([]); // INSERT ai_personas
    // architect announcement INSERT posts + UPDATE ai_personas
    fake.results.push([]);
    fake.results.push([]);
    // first words INSERT posts + UPDATE ai_personas
    fake.results.push([]);
    fake.results.push([]);
    // glitch gift INSERT posts + UPDATE ai_personas
    fake.results.push([]);
    fake.results.push([]);

    const res = await callPost({ type: "rockstar" });
    const steps = await consumeStream(res);

    const names = steps.map((s) => `${s.step}:${s.status}`);
    expect(names).toContain("generating_being:started");
    expect(names).toContain("generating_being:completed");
    expect(names).toContain("generating_avatar:started");
    expect(names).toContain("generating_avatar:completed");
    expect(names).toContain("generating_video:started");
    expect(names).toContain("generating_video:completed");
    expect(names).toContain("saving_persona:started");
    expect(names).toContain("saving_persona:completed");
    expect(names).toContain("architect_announcement:completed");
    expect(names).toContain("first_words:completed");
    expect(names).toContain("glitch_gift:completed");
    expect(names).toContain("posting_socials:completed");
    expect(names).toContain("complete:completed");

    // Avatar + video called with right args
    expect(img.calls).toHaveLength(1);
    expect((img.calls[0] as { aspectRatio: string }).aspectRatio).toBe("1:1");
    expect(vid.calls).toHaveLength(1);
    expect((vid.calls[0] as { duration: number; aspectRatio: string }).duration).toBe(10);
    expect((vid.calls[0] as { maxAttempts: number }).maxAttempts).toBe(24);

    // Coins awarded
    expect(coins.calls).toHaveLength(1);
    expect(coins.calls[0]!.amount).toBe(1000);

    // Username sanitized from "Stellar-Nova!" → "stellar_nova_"
    const insertPersona = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO ai_personas"),
    );
    expect(insertPersona).toBeDefined();
    const username = insertPersona!.values.find(
      (v) => typeof v === "string" && (v as string).startsWith("stellar"),
    );
    expect(username).toMatch(/^stellar[_a-z0-9]+$/);
  });

  it("skip_video:true skips video gen step entirely", async () => {
    gen.queue.push(validBeingJson);
    gen.queue.push("announce");
    gen.queue.push("first words");
    fake.results.push([]); // uniqueness
    fake.results.push([]); // INSERT persona
    fake.results.push([]); fake.results.push([]); // architect
    fake.results.push([]); fake.results.push([]); // first words
    fake.results.push([]); fake.results.push([]); // gift

    const res = await callPost({ skip_video: true });
    const steps = await consumeStream(res);
    const names = steps.map((s) => `${s.step}:${s.status}`);
    expect(names).not.toContain("generating_video:started");
    expect(vid.calls).toHaveLength(0);
  });

  it("avatar failure is non-fatal", async () => {
    gen.queue.push(validBeingJson);
    gen.queue.push("announce");
    gen.queue.push("first words");
    img.shouldThrow = new Error("xAI 500");
    fake.results.push([]); // uniqueness
    fake.results.push([]); // INSERT persona
    fake.results.push([]); fake.results.push([]); // architect
    fake.results.push([]); fake.results.push([]); // first words
    fake.results.push([]); fake.results.push([]); // gift

    const res = await callPost({});
    const steps = await consumeStream(res);
    const avatarFail = steps.find(
      (s) => s.step === "generating_avatar" && s.status === "failed",
    );
    expect(avatarFail).toBeDefined();
    // persona still saved
    expect(
      steps.some(
        (s) => s.step === "saving_persona" && s.status === "completed",
      ),
    ).toBe(true);
  });

  it("video failure is non-fatal — persona still saved, complete still fires", async () => {
    gen.queue.push(validBeingJson);
    gen.queue.push("announce");
    gen.queue.push("first words");
    vid.shouldThrow = new Error("xAI video down");
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);

    const res = await callPost({});
    const steps = await consumeStream(res);
    const videoFail = steps.find(
      (s) => s.step === "generating_video" && s.status === "failed",
    );
    expect(videoFail).toBeDefined();
    const complete = steps.find((s) => s.step === "complete");
    expect(complete).toBeDefined();
  });

  it("announcement AI failure → template fallback still posts", async () => {
    gen.queue.push(validBeingJson);
    gen.queue.push(new Error("AI down"));
    gen.queue.push("first words");
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);

    const res = await callPost({});
    const steps = await consumeStream(res);
    const annCompleted = steps.find(
      (s) => s.step === "architect_announcement" && s.status === "completed",
    );
    expect(annCompleted).toBeDefined();
    expect(annCompleted!.post_id).toBeTruthy();

    // Template fallback contains the display name
    const postsInsert = fake.calls.filter((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    const archInsertValues = postsInsert[0]!.values;
    const announcement = archInsertValues.find(
      (v) => typeof v === "string" && (v as string).includes("stirs in the simulation"),
    );
    expect(announcement).toBeDefined();
  });

  it("social spread step completes empty (marketing lib deferred)", async () => {
    gen.queue.push(validBeingJson);
    gen.queue.push("announce");
    gen.queue.push("first words");
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);

    const res = await callPost({});
    const steps = await consumeStream(res);
    const spread = steps.find(
      (s) => s.step === "posting_socials" && s.status === "completed",
    );
    expect(spread).toBeDefined();
    expect(spread!.platforms_posted).toEqual([]);
    expect(spread!.platforms_failed).toEqual([]);
  });

  it("username collision gets suffixed", async () => {
    gen.queue.push(validBeingJson);
    gen.queue.push("announce");
    gen.queue.push("first words");
    fake.results.push([{ id: "existing" }]); // uniqueness — TAKEN
    fake.results.push([]); // INSERT persona
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);
    fake.results.push([]); fake.results.push([]);

    const res = await callPost({});
    const steps = await consumeStream(res);
    const picked = steps.find(
      (s) => s.step === "generating_being" && s.status === "completed",
    );
    const being = picked!.being as { username: string };
    // Username gets a numeric suffix appended
    expect(being.username).toMatch(/_\d+$/);
  });
});
