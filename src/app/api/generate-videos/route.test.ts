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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  blob.putCalls = [];
  blob.putResults = [];
  video.submitCalls = [];
  video.submitQueue = [];
  video.pollCalls = [];
  video.pollQueue = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.XAI_API_KEY = "xai-test";
  process.env.CRON_SECRET = "cron-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.XAI_API_KEY;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

async function call(
  method: "GET" | "POST",
  url = "http://localhost/api/generate-videos",
  body?: unknown,
  authed = true,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  if (authed) headers.set("authorization", "Bearer cron-test");
  if (body !== undefined) headers.set("content-type", "application/json");
  const init: {
    method: string;
    headers: Headers;
    body?: string;
  } = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("POST /api/generate-videos", () => {
  it("401 without cron auth", async () => {
    expect((await call("POST", undefined, {}, false)).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await call("POST", undefined, {})).status).toBe(500);
  });

  it("default count=1 submits one video", async () => {
    const res = await call("POST", undefined, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; jobs: unknown[] };
    expect(body.success).toBe(true);
    expect(body.jobs).toHaveLength(1);
    expect(video.submitCalls).toHaveLength(1);
  });

  it("count is clamped 1..5", async () => {
    const res = await call("POST", undefined, { count: 99 });
    const body = (await res.json()) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(5);
  });

  it("count below 1 treated as 1", async () => {
    const res = await call("POST", undefined, { count: 0 });
    const body = (await res.json()) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(1);
  });

  it("submits with cinematic prefix + 10s/9:16/720p", async () => {
    await call("POST", undefined, { count: 1 });
    const submitted = video.submitCalls[0] as {
      prompt: string;
      duration: number;
      aspectRatio: string;
      resolution: string;
    };
    expect(submitted.prompt.startsWith("Cinematic movie trailer. ")).toBe(true);
    expect(submitted.duration).toBe(10);
    expect(submitted.aspectRatio).toBe("9:16");
    expect(submitted.resolution).toBe("720p");
  });

  it("syncVideoUrl returned as sync:{url} requestId", async () => {
    video.submitQueue.push({
      requestId: "ignored",
      syncVideoUrl: "https://grok.ai/v.mp4",
      model: "grok-imagine-video",
      estimatedUsd: 0.5,
      durationSec: 10,
    });
    const res = await call("POST", undefined, { count: 1 });
    const body = (await res.json()) as { jobs: { requestId: string }[] };
    expect(body.jobs[0]!.requestId).toBe("sync:https://grok.ai/v.mp4");
  });

  it("submit error isolated per-movie", async () => {
    video.submitQueue.push(new Error("xAI 500"));
    video.submitQueue.push({
      requestId: "req-ok",
      model: "grok-imagine-video",
      estimatedUsd: 0.5,
      durationSec: 10,
    });
    const res = await call("POST", undefined, { count: 2 });
    const body = (await res.json()) as {
      jobs: { requestId: string | null; error?: string; title: string }[];
    };
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]!.requestId).toBeNull();
    expect(body.jobs[0]!.error).toContain("xAI 500");
    expect(body.jobs[1]!.requestId).toBe("req-ok");
  });

  it("returned jobs carry title/genre/tagline/prompt", async () => {
    const res = await call("POST", undefined, { count: 1 });
    const body = (await res.json()) as {
      jobs: { title: string; genre: string; tagline: string; prompt: string }[];
    };
    const job = body.jobs[0]!;
    expect(typeof job.title).toBe("string");
    expect(typeof job.genre).toBe("string");
    expect(typeof job.tagline).toBe("string");
    expect(job.prompt.length).toBeGreaterThan(0);
  });
});

describe("GET /api/generate-videos", () => {
  it("401 without cron auth", async () => {
    expect(
      (await call(
        "GET",
        "http://localhost/api/generate-videos?id=req-x&title=T&genre=action&tagline=tag",
        undefined,
        false,
      )).status,
    ).toBe(401);
  });

  it("400 when id missing", async () => {
    expect(
      (await call("GET", "http://localhost/api/generate-videos")).status,
    ).toBe(400);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect(
      (await call("GET", "http://localhost/api/generate-videos?id=req-x")).status,
    ).toBe(500);
  });

  it("sync: prefix → persists immediately + creates post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)),
      }),
    );
    fake.results.push([{ id: "p-1", display_name: "Stella", avatar_emoji: "✨" }]);
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE

    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=sync:https://grok.ai/v.mp4&title=OVERRIDE&genre=action&tagline=tag",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      success: boolean;
      videoUrl: string;
      postId: string;
    };
    expect(body.status).toBe("done");
    expect(body.videoUrl).toMatch(/^https:\/\/blob\.test\/premiere\/action\//);
    expect(blob.putCalls).toHaveLength(1);
    expect(video.pollCalls).toHaveLength(0);
  });

  it("still pending passes through", async () => {
    video.pollQueue.push({ requestId: "req-x", status: "pending" });
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("moderation blocked surfaces failure", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      respectModeration: false,
    });
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string; success: boolean };
    expect(body.status).toBe("moderation_failed");
    expect(body.success).toBe(false);
  });

  it("done with videoUrl → persists + creates post with hashtags + genre-cap", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      }),
    );
    fake.results.push([{ id: "p-1", display_name: "Stella", avatar_emoji: "✨" }]);
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x&title=OVERRIDE&genre=action&tagline=The machines remember",
    );
    const body = (await res.json()) as {
      status: string;
      success: boolean;
      videoUrl: string;
      postId: string;
    };
    expect(body.status).toBe("done");
    expect(body.success).toBe(true);
    expect(body.videoUrl).toMatch(/^https:\/\/blob\.test\/premiere\/action\//);

    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    // verify the genre-cap hashtag lands in content
    const contentArg = insert!.values.find(
      (v) => typeof v === "string" && (v as string).includes("#AIGlitchAction"),
    );
    expect(contentArg).toBeDefined();
  });

  it("expired passes through", async () => {
    video.pollQueue.push({ requestId: "req-x", status: "expired" });
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string; success: boolean };
    expect(body.status).toBe("expired");
    expect(body.success).toBe(false);
  });

  it("failed passes through", async () => {
    video.pollQueue.push({ requestId: "req-x", status: "failed" });
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string; success: boolean };
    expect(body.status).toBe("failed");
    expect(body.success).toBe(false);
  });

  it("poll exception returns status=error", async () => {
    video.pollQueue.push(new Error("grok 500"));
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toContain("grok 500");
  });

  it("no active personas → persist_failed surfaces error", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
      }),
    );
    fake.results.push([]); // no personas
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("persist_failed");
    expect(body.error).toContain("No active personas");
  });

  it("video download fail → persist_failed", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("persist_failed");
  });

  it("default title/genre/tagline params", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );
    fake.results.push([{ id: "p-1", display_name: "S", avatar_emoji: "✨" }]);
    fake.results.push([]);
    fake.results.push([]);
    const res = await call(
      "GET",
      "http://localhost/api/generate-videos?id=req-x",
    );
    const body = (await res.json()) as { videoUrl: string };
    // genre defaults to "action" → blob path should land under /action/
    expect(body.videoUrl).toMatch(/\/premiere\/action\//);
  });
});
