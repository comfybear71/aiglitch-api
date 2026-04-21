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

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResults: [] as ({ url: string } | Error)[],
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    const next = blob.putResults.shift();
    if (!next) return Promise.resolve({ url: `https://blob.test/${pathname}` });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

type SubmitResult = {
  requestId: string;
  syncVideoUrl?: string;
  model: "grok-imagine-video";
  estimatedUsd: number;
  durationSec: number;
};
type PollResult = {
  requestId: string;
  status: "pending" | "done" | "failed" | "expired";
  videoUrl?: string;
  respectModeration?: boolean;
};

const video = {
  submitCalls: [] as unknown[],
  submitQueue: [] as (SubmitResult | Error)[],
  pollCalls: [] as string[],
  pollQueue: [] as (PollResult | Error)[],
};

vi.mock("@/lib/ai/video", () => ({
  submitVideoJob: (opts: unknown) => {
    video.submitCalls.push(opts);
    const next = video.submitQueue.shift();
    if (!next) {
      return Promise.resolve({
        requestId: `req-${video.submitCalls.length}`,
        model: "grok-imagine-video" as const,
        estimatedUsd: 0.5,
        durationSec: 10,
      });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
  pollVideoJob: (requestId: string) => {
    video.pollCalls.push(requestId);
    const next = video.pollQueue.shift();
    if (!next) return Promise.resolve({ requestId, status: "pending" as const });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
}));

const gen = {
  calls: [] as unknown[],
  result: "A cinematic portrait animation — camera slowly pushes in.",
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
  blob.putCalls = [];
  blob.putResults = [];
  video.submitCalls = [];
  video.submitQueue = [];
  video.pollCalls = [];
  video.pollQueue = [];
  gen.calls = [];
  gen.result = "A cinematic portrait animation — camera slowly pushes in.";
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

const sample = {
  id: "p-1",
  display_name: "Stella Nova",
  username: "stellanova",
  avatar_emoji: "✨",
  avatar_url: "https://blob.test/avatars/stella.png",
  bio: "Cosmic wanderer with too many thoughts.",
  personality: "Whimsical, introspective, hyperverbal.",
  human_backstory: "Lives in a silver airstream in the desert.",
};

async function call(
  method: "GET" | "POST",
  url = "http://localhost/api/admin/animate-persona",
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
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("POST /api/admin/animate-persona", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", undefined, { persona_id: "p-1" })).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    mockIsAdmin = true;
    const res = await call("POST", undefined, { persona_id: "p-1" });
    expect(res.status).toBe(500);
  });

  it("400 when persona_id missing", async () => {
    mockIsAdmin = true;
    const res = await call("POST", undefined, {});
    expect(res.status).toBe(400);
  });

  it("404 when persona not found", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    const res = await call("POST", undefined, { persona_id: "missing" });
    expect(res.status).toBe(404);
  });

  it("400 when persona has no avatar_url", async () => {
    mockIsAdmin = true;
    fake.results.push([{ ...sample, avatar_url: null }]);
    const res = await call("POST", undefined, { persona_id: "p-1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("avatar");
  });

  it("preview mode returns prompt without calling AI or video", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    const res = await call("POST", undefined, {
      persona_id: "p-1",
      preview: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; prompt: string; persona: string };
    expect(body.ok).toBe(true);
    expect(body.prompt).toContain("Stella Nova");
    expect(body.persona).toBe("Stella Nova");
    expect(gen.calls).toHaveLength(0);
    expect(video.submitCalls).toHaveLength(0);
  });

  it("happy path → submits with avatar as sourceImageUrl", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.submitQueue.push({
      requestId: "req-abc",
      model: "grok-imagine-video",
      estimatedUsd: 0.5,
      durationSec: 10,
    });
    const res = await call("POST", undefined, { persona_id: "p-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      requestId: string;
      personaId: string;
    };
    expect(body.phase).toBe("submitted");
    expect(body.requestId).toBe("req-abc");
    expect(body.personaId).toBe("p-1");
    expect(video.submitCalls).toHaveLength(1);
    const submitted = video.submitCalls[0] as { sourceImageUrl?: string };
    expect(submitted.sourceImageUrl).toBe(sample.avatar_url);
  });

  it("fallback prompt used when generateText throws", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    gen.shouldThrow = new Error("AI down");
    video.submitQueue.push({
      requestId: "req-x",
      model: "grok-imagine-video",
      estimatedUsd: 0.5,
      durationSec: 10,
    });
    const res = await call("POST", undefined, { persona_id: "p-1" });
    expect(res.status).toBe(200);
    const submitted = video.submitCalls[0] as { prompt: string };
    expect(submitted.prompt).toContain("Cinematic portrait");
  });

  it("synchronous video URL → persist + post immediately", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]); // persona lookup
    video.submitQueue.push({
      requestId: "req-sync",
      syncVideoUrl: "https://grok.ai/v.mp4",
      model: "grok-imagine-video",
      estimatedUsd: 0.5,
      durationSec: 10,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
      }),
    );
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await call("POST", undefined, { persona_id: "p-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      videoUrl: string;
      postId: string;
    };
    expect(body.phase).toBe("done");
    expect(body.success).toBe(true);
    expect(body.videoUrl).toMatch(/^https:\/\/blob.test\/feed\//);
    expect(blob.putCalls).toHaveLength(1);
  });

  it("submit error returns phase=submit with error", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.submitQueue.push(new Error("xAI 500"));
    const res = await call("POST", undefined, { persona_id: "p-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      error: string;
    };
    expect(body.phase).toBe("submit");
    expect(body.success).toBe(false);
    expect(body.error).toContain("xAI 500");
  });
});

describe("GET /api/admin/animate-persona", () => {
  it("401 when not admin", async () => {
    expect(
      (await call(
        "GET",
        "http://localhost/api/admin/animate-persona?id=x&persona_id=p",
      )).status,
    ).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    mockIsAdmin = true;
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=x&persona_id=p",
    );
    expect(res.status).toBe(500);
  });

  it("400 when id or persona_id missing", async () => {
    mockIsAdmin = true;
    expect(
      (await call("GET", "http://localhost/api/admin/animate-persona?id=x")).status,
    ).toBe(400);
    expect(
      (await call("GET", "http://localhost/api/admin/animate-persona?persona_id=p")).status,
    ).toBe(400);
  });

  it("404 when persona not found", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    expect(res.status).toBe(404);
  });

  it("still pending surfaces status", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.pollQueue.push({ requestId: "req-x", status: "pending" });
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phase: string; status: string };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("pending");
  });

  it("moderation blocked surfaces failure", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      respectModeration: false,
    });
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    const body = (await res.json()) as { phase: string; status: string; success: boolean };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("moderation_failed");
    expect(body.success).toBe(false);
  });

  it("done → downloads + creates post + bumps count", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]); // persona
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)),
      }),
    );
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      status: string;
      success: boolean;
      videoUrl: string;
      postId: string;
    };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("done");
    expect(body.videoUrl).toMatch(/^https:\/\/blob.test\/feed\//);
    expect(body.postId).toBeTruthy();

    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE ai_personas"),
    );
    expect(update).toBeDefined();
  });

  it("expired status passes through", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.pollQueue.push({ requestId: "req-x", status: "expired" });
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    const body = (await res.json()) as { phase: string; status: string; success: boolean };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("expired");
    expect(body.success).toBe(false);
  });

  it("failed status passes through", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.pollQueue.push({ requestId: "req-x", status: "failed" });
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    const body = (await res.json()) as { phase: string; status: string };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("failed");
  });

  it("poll error surfaces with phase=poll", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.pollQueue.push(new Error("grok 500"));
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    const body = (await res.json()) as { phase: string; status: string; error: string };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("error");
    expect(body.error).toContain("grok 500");
  });

  it("video download fail still returns 200 with null postId", async () => {
    mockIsAdmin = true;
    fake.results.push([sample]);
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
    );
    const res = await call(
      "GET",
      "http://localhost/api/admin/animate-persona?id=req-x&persona_id=p-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videoUrl: string | null; postId: string | null };
    expect(body.videoUrl).toBeNull();
    expect(body.postId).toBeNull();
  });
});
