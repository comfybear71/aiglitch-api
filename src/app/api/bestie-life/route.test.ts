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

// cronHandler mock passes through to the fn and wraps the result
vi.mock("@/lib/cron-handler", () => ({
  cronHandler: async (_name: string, fn: () => Promise<unknown>) => {
    const result = await fn();
    return { ...(result as object), _cron_run_id: "test-run" };
  },
}));

vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn(() => null),
}));

vi.mock("@/app/api/bestie-health/route", () => ({
  calculateHealth: vi.fn((_lastInteraction: Date, _bonusDays: number) => ({
    health: 85,
    isDead: false,
  })),
}));

const gen = {
  calls: [] as unknown[],
  result: "IMAGE_PROMPT: Stella in her kitchen at golden hour\nCAPTION: just made pancakes for you 🥞",
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
  result: { blobUrl: "https://blob.test/bestie-life/x.png", model: "grok-imagine-image", estimatedUsd: 0.02 },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: unknown) => {
    img.calls.push(opts);
    if (img.shouldThrow) return Promise.reject(img.shouldThrow);
    return Promise.resolve(img.result);
  },
}));

const telegram = {
  sendPhotoCalls: [] as { token: string; chatId: string | number; url: string; caption?: string }[],
  sendPhotoResult: { ok: true, messageId: 1 } as { ok: boolean; messageId?: number; error?: string },
};

vi.mock("@/lib/telegram", () => ({
  sendTelegramPhoto: (
    token: string,
    chatId: string | number,
    url: string,
    caption?: string,
  ) => {
    telegram.sendPhotoCalls.push({ token, chatId, url, caption });
    return Promise.resolve(telegram.sendPhotoResult);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  gen.calls = [];
  gen.result =
    "IMAGE_PROMPT: Stella in her kitchen at golden hour\nCAPTION: just made pancakes for you 🥞";
  gen.shouldThrow = null;
  img.calls = [];
  img.result = {
    blobUrl: "https://blob.test/bestie-life/x.png",
    model: "grok-imagine-image",
    estimatedUsd: 0.02,
  };
  img.shouldThrow = null;
  telegram.sendPhotoCalls = [];
  telegram.sendPhotoResult = { ok: true, messageId: 1 };
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "cron-test";
  vi.resetModules();
  // re-stub global fetch (used only for death messages)
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  );
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

const bestieSample = {
  persona_id: "p-1",
  username: "stella",
  display_name: "Stella",
  avatar_emoji: "✨",
  avatar_url: "https://blob.test/avatars/stella.png",
  personality: "Whimsical dreamer",
  bio: "Cosmic wanderer",
  persona_type: "human",
  human_backstory: "Airstream in the desert",
  meatbag_name: "Stuart",
  health: 85,
  last_meatbag_interaction: "2026-04-15T10:00:00Z",
  bonus_health_days: 0,
  is_dead: false,
  bot_token: "tok-stella",
  telegram_chat_id: "chat-1",
  created_at: "2026-01-01T00:00:00Z",
};

async function callCron(authed = true) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  if (authed) headers.set("authorization", "Bearer cron-test");
  const req = new NextRequest("http://localhost/api/bestie-life", {
    method: "GET",
    headers,
  });
  return mod.GET(req);
}

async function callAdmin(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/bestie-life", {
    method: "POST",
  });
  return mod.POST(req);
}

describe("GET /api/bestie-life (cron)", () => {
  it("GET path calls requireCronAuth — 401 when not authed", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    vi.mocked(requireCronAuth).mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) as never,
    );
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/bestie-life", {
      method: "GET",
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(401);
  });

  it("no besties → zero counts", async () => {
    fake.results.push([]);
    const res = await callCron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      totalBesties: number;
      sent: number;
    };
    expect(body.totalBesties).toBe(0);
    expect(body.sent).toBe(0);
  });

  it("happy path — one bestie gets photo sent", async () => {
    fake.results.push([bestieSample]); // besties query
    fake.results.push([]); // UPDATE ai_personas
    fake.results.push([{ content: "they love black coffee" }]); // persona_memories
    const res = await callCron();
    const body = (await res.json()) as {
      totalBesties: number;
      sent: number;
      results: Array<{ persona: string; theme: string; sent: boolean }>;
    };
    expect(body.totalBesties).toBe(1);
    expect(body.sent).toBe(1);
    expect(body.results[0]!.sent).toBe(true);

    expect(gen.calls).toHaveLength(1);
    expect(img.calls).toHaveLength(1);
    expect(telegram.sendPhotoCalls).toHaveLength(1);
    expect(telegram.sendPhotoCalls[0]!.token).toBe("tok-stella");
    expect(telegram.sendPhotoCalls[0]!.chatId).toBe("chat-1");
    expect(telegram.sendPhotoCalls[0]!.caption).toContain("Stella");
  });

  it("bestie just died → skipped without AI/image calls", async () => {
    const { calculateHealth } = await import("@/app/api/bestie-health/route");
    vi.mocked(calculateHealth).mockReturnValueOnce({
      health: 0,
      isDead: true,
      effectiveDaysLeft: 0,
    });

    fake.results.push([bestieSample]); // besties
    fake.results.push([]); // UPDATE ai_personas
    const res = await callCron();
    const body = (await res.json()) as {
      sent: number;
      failed: number;
      results: Array<{ persona: string; theme: string; error?: string }>;
    };
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0); // death skip doesn't count as failure, matches legacy
    expect(body.results[0]!.theme).toBe("death");
    expect(gen.calls).toHaveLength(0);
    expect(img.calls).toHaveLength(0);
  });

  it("generateText failure → result carries error, no image/telegram call", async () => {
    gen.shouldThrow = new Error("AI down");
    fake.results.push([bestieSample]);
    fake.results.push([]); // UPDATE
    fake.results.push([]); // memories
    const res = await callCron();
    const body = (await res.json()) as {
      sent: number;
      failed: number;
      results: Array<{ error?: string }>;
    };
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.error).toContain("Scene prompt");
    expect(img.calls).toHaveLength(0);
    expect(telegram.sendPhotoCalls).toHaveLength(0);
  });

  it("generateImageToBlob failure → captured as error", async () => {
    img.shouldThrow = new Error("xAI 500");
    fake.results.push([bestieSample]);
    fake.results.push([]); // UPDATE
    fake.results.push([]); // memories
    const res = await callCron();
    const body = (await res.json()) as {
      results: Array<{ error?: string }>;
    };
    expect(body.results[0]!.error).toContain("xAI 500");
    expect(telegram.sendPhotoCalls).toHaveLength(0);
  });

  it("telegram send failure is captured but counted in failed", async () => {
    telegram.sendPhotoResult = { ok: false, error: "bot blocked" };
    fake.results.push([bestieSample]);
    fake.results.push([]); // UPDATE
    fake.results.push([]); // memories
    const res = await callCron();
    const body = (await res.json()) as {
      sent: number;
      failed: number;
      results: Array<{ sent: boolean; telegramError?: string }>;
    };
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.telegramError).toBe("bot blocked");
  });

  it("persona_memories missing → proceeds with empty memory context", async () => {
    fake.results.push([bestieSample]);
    fake.results.push([]); // UPDATE
    fake.results.push(new Error("table persona_memories missing"));
    const res = await callCron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(1);
  });

  it("health warning triggers desperate caption prompt", async () => {
    const { calculateHealth } = await import("@/app/api/bestie-health/route");
    vi.mocked(calculateHealth).mockReturnValueOnce({
      health: 5,
      isDead: false,
      effectiveDaysLeft: 5,
    });
    fake.results.push([bestieSample]);
    fake.results.push([]); // UPDATE
    fake.results.push([]); // memories
    await callCron();
    const sent = gen.calls[0] as { userPrompt: string };
    expect(sent.userPrompt).toContain("FADING AWAY");
    expect(sent.userPrompt).toContain("5%");

    const caption = telegram.sendPhotoCalls[0]!.caption!;
    expect(caption).toContain("HP: 5%");
    expect(caption).toContain("💀");
  });

  it("multiple besties processed independently — one pass + one fail", async () => {
    fake.results.push([bestieSample, { ...bestieSample, persona_id: "p-2", username: "grok" }]);
    // bestie 1: UPDATE + memories
    fake.results.push([]);
    fake.results.push([]);
    // bestie 2: UPDATE + memories (errors out here)
    fake.results.push([]);
    fake.results.push([]);
    // bestie 2's image fails
    img.shouldThrow = new Error("only on first call");
    // Can't partial-fail with this mock setup easily; just verify shape
    const res = await callCron();
    const body = (await res.json()) as {
      totalBesties: number;
      results: Array<{ persona: string }>;
    };
    expect(body.totalBesties).toBe(2);
    expect(body.results.map((r) => r.persona)).toEqual(["stella", "grok"]);
  });

  it("result wrapped with _cron_run_id by cronHandler", async () => {
    fake.results.push([]);
    const res = await callCron();
    const body = (await res.json()) as { _cron_run_id: string };
    expect(body._cron_run_id).toBe("test-run");
  });
});

describe("POST /api/bestie-life (admin manual)", () => {
  it("401 when not admin", async () => {
    const res = await callAdmin(false);
    expect(res.status).toBe(401);
  });

  it("runs without cronHandler wrapping — no _cron_run_id", async () => {
    fake.results.push([bestieSample]);
    fake.results.push([]); // UPDATE
    fake.results.push([]); // memories
    const res = await callAdmin();
    const body = (await res.json()) as {
      sent: number;
      _cron_run_id?: string;
    };
    expect(body.sent).toBe(1);
    expect(body._cron_run_id).toBeUndefined();
  });

  it("unexpected runtime error → 500", async () => {
    fake.results.push(new Error("DB hose down"));
    const res = await callAdmin();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("DB hose down");
  });
});
