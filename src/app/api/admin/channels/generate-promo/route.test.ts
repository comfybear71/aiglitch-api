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
  putThrow: null as Error | null,
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    if (blob.putThrow) return Promise.reject(blob.putThrow);
    return Promise.resolve({ url: `https://blob.test/${pathname}` });
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
    const next = video.pollQueue.shift();
    if (!next) return Promise.resolve({ requestId, status: "pending" as const });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  blob.putCalls = [];
  blob.putThrow = null;
  video.submitCalls = [];
  video.submitQueue = [];
  video.pollQueue = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.XAI_API_KEY = "xai-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callPost(body?: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
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
  const req = new NextRequest(
    "http://localhost/api/admin/channels/generate-promo",
    init,
  );
  return mod.POST(req);
}

async function callGet(query: string, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/admin/channels/generate-promo${query}`,
    { method: "GET" },
  );
  return mod.GET(req);
}

async function callPut(body?: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "PUT",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(
    "http://localhost/api/admin/channels/generate-promo",
    init,
  );
  return mod.PUT(req);
}

describe("POST /api/admin/channels/generate-promo", () => {
  it("401 when not admin", async () => {
    expect((await callPost({}, false)).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    const res = await callPost({ channel_id: "c", channel_slug: "s" });
    expect(res.status).toBe(500);
  });

  it("400 when required fields missing", async () => {
    expect((await callPost({})).status).toBe(400);
    expect((await callPost({ channel_id: "c" })).status).toBe(400);
  });

  it("400 when no default scenes and no custom_prompt", async () => {
    const res = await callPost({
      channel_id: "ch-x",
      channel_slug: "unknown-channel",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("No promo scenes");
  });

  it("preview mode returns the prompt without submitting", async () => {
    const res = await callPost({
      channel_id: "ch-fail",
      channel_slug: "ai-fail-army",
      preview: true,
    });
    const body = (await res.json()) as { ok: boolean; prompt: string };
    expect(body.ok).toBe(true);
    expect(body.prompt).toContain("shelf rips off the wall");
    expect(body.prompt).toContain("AIG!itch");
    expect(video.submitCalls).toHaveLength(0);
  });

  it("custom_prompt overrides default scene", async () => {
    await callPost({
      channel_id: "c",
      channel_slug: "ai-fail-army",
      custom_prompt: "a cat knocks over a laptop",
    });
    const sent = video.submitCalls[0] as { prompt: string };
    expect(sent.prompt).toContain("cat knocks over a laptop");
    expect(sent.prompt).not.toContain("shelf rips");
  });

  it("happy path submits 10s 9:16 720p", async () => {
    const res = await callPost({
      channel_id: "ch-gnn",
      channel_slug: "gnn",
    });
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      totalClips: number;
      clips: { scene: number; requestId: string | null }[];
    };
    expect(body.phase).toBe("submitted");
    expect(body.totalClips).toBe(1);
    expect(body.clips[0]!.requestId).toBe("req-1");

    const sent = video.submitCalls[0] as {
      duration: number;
      aspectRatio: string;
      resolution: string;
    };
    expect(sent.duration).toBe(10);
    expect(sent.aspectRatio).toBe("9:16");
    expect(sent.resolution).toBe("720p");
  });

  it("sync video URL returned inline via videoUrl", async () => {
    video.submitQueue.push({
      requestId: "req-sync",
      syncVideoUrl: "https://grok.ai/sync.mp4",
      model: "grok-imagine-video",
      estimatedUsd: 0.5,
      durationSec: 10,
    });
    const res = await callPost({
      channel_id: "c",
      channel_slug: "gnn",
    });
    const body = (await res.json()) as {
      clips: { requestId: string | null; videoUrl: string | null }[];
    };
    expect(body.clips[0]!.requestId).toBeNull();
    expect(body.clips[0]!.videoUrl).toBe("https://grok.ai/sync.mp4");
  });

  it("submit error returns phase=submit with error", async () => {
    video.submitQueue.push(new Error("xAI 500"));
    const res = await callPost({ channel_id: "c", channel_slug: "gnn" });
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

describe("GET /api/admin/channels/generate-promo", () => {
  it("401 when not admin", async () => {
    expect((await callGet("?id=r", false)).status).toBe(401);
  });

  it("400 when id missing", async () => {
    expect((await callGet("")).status).toBe(400);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await callGet("?id=r")).status).toBe(500);
  });

  it("pending passes through", async () => {
    video.pollQueue.push({ requestId: "r", status: "pending" });
    const body = (await (await callGet("?id=r")).json()) as {
      phase: string;
      status: string;
    };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("pending");
  });

  it("moderation blocked surfaces moderation_failed", async () => {
    video.pollQueue.push({
      requestId: "r",
      status: "done",
      respectModeration: false,
    });
    const body = (await (await callGet("?id=r")).json()) as {
      status: string;
      success: boolean;
    };
    expect(body.status).toBe("moderation_failed");
    expect(body.success).toBe(false);
  });

  it("done + videoUrl → persist to channels/clips/{uuid}.mp4", async () => {
    video.pollQueue.push({
      requestId: "r",
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
    const body = (await (await callGet("?id=r")).json()) as {
      blobUrl: string;
    };
    expect(body.blobUrl).toMatch(/^https:\/\/blob\.test\/channels\/clips\//);
  });

  it("download failure falls back to returning the Grok URL", async () => {
    video.pollQueue.push({
      requestId: "r",
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
    const body = (await (await callGet("?id=r")).json()) as {
      blobUrl: string;
    };
    expect(body.blobUrl).toBe("https://grok.ai/v.mp4");
  });

  it("expired / failed pass through", async () => {
    video.pollQueue.push({ requestId: "r", status: "expired" });
    const body = (await (await callGet("?id=r")).json()) as {
      phase: string;
      status: string;
      success: boolean;
    };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("expired");
    expect(body.success).toBe(false);
  });

  it("poll exception surfaces error", async () => {
    video.pollQueue.push(new Error("grok 500"));
    const body = (await (await callGet("?id=r")).json()) as {
      phase: string;
      status: string;
    };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("error");
  });
});

describe("PUT /api/admin/channels/generate-promo", () => {
  it("401 when not admin", async () => {
    expect((await callPut({}, false)).status).toBe(401);
  });

  it("400 when fields missing", async () => {
    expect((await callPut({})).status).toBe(400);
    expect(
      (
        await callPut({
          channel_id: "c",
          channel_slug: "s",
          clip_urls: [],
        })
      ).status,
    ).toBe(400);
  });

  it("happy path downloads + persists + updates channel + creates post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2 * 1024 * 1024)),
      }),
    );
    fake.results.push([]); // UPDATE channels
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await callPut({
      channel_id: "ch-news",
      channel_slug: "ai-news",
      clip_urls: ["https://blob.test/channels/clips/abc.mp4"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      blobUrl: string;
      sizeMb: string;
      postId: string;
    };
    expect(body.success).toBe(true);
    expect(body.blobUrl).toMatch(/^https:\/\/blob\.test\/channels\/ai-news\/promo-/);
    expect(Number(body.sizeMb)).toBeGreaterThan(0);

    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    // channel_id column gets the passed id
    expect(insert!.values).toContain("ch-news");
    // Architect is the author
    expect(insert!.values).toContain("glitch-000");
    // Post content has the channel name capitalized
    const content = insert!.values.find(
      (v) => typeof v === "string" && (v as string).includes("Welcome to Ai News"),
    );
    expect(content).toBeDefined();
  });

  it("clip download failure returns 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );
    const res = await callPut({
      channel_id: "c",
      channel_slug: "s",
      clip_urls: ["https://blob.test/missing.mp4"],
    });
    expect(res.status).toBe(500);
  });
});
