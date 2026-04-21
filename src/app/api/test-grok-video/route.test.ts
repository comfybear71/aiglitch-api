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
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
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
  mockIsAdmin = false;
  blob.putCalls = [];
  video.submitCalls = [];
  video.submitQueue = [];
  video.pollCalls = [];
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
  const req = new NextRequest("http://localhost/api/test-grok-video", init);
  return mod.POST(req);
}

async function callGet(query: string, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/test-grok-video${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

describe("POST /api/test-grok-video", () => {
  it("401 when not admin", async () => {
    expect((await callPost({}, false)).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await callPost({})).status).toBe(500);
  });

  it("happy submit returns phase=submitted + requestId", async () => {
    const res = await callPost({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      requestId: string;
      duration: number;
      folder: string;
    };
    expect(body.phase).toBe("submitted");
    expect(body.requestId).toBe("req-1");
    expect(body.duration).toBe(10);
    expect(body.folder).toBe("test");
  });

  it("image_url propagates as sourceImageUrl", async () => {
    await callPost({ image_url: "https://x.com/ref.png" });
    const sent = video.submitCalls[0] as { sourceImageUrl: string };
    expect(sent.sourceImageUrl).toBe("https://x.com/ref.png");
  });

  it("syncVideoUrl → phase=done + persists + auto-posts", async () => {
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
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)),
      }),
    );
    fake.results.push([{ id: "p-1" }]); // random persona
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE

    const res = await callPost({ folder: "test" });
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      blobUrl: string;
      postId: string;
      autoPosted: boolean;
    };
    expect(body.phase).toBe("done");
    expect(body.autoPosted).toBe(true);
    expect(blob.putCalls[0]!.pathname).toMatch(/^test\/.*\.mp4$/);
  });

  it("submit error returns phase=submit with error", async () => {
    video.submitQueue.push(new Error("xAI 500"));
    const res = await callPost({});
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

describe("GET /api/test-grok-video", () => {
  it("401 when not admin", async () => {
    expect((await callGet("?id=req-x", false)).status).toBe(401);
  });

  it("400 when id missing", async () => {
    expect((await callGet("")).status).toBe(400);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await callGet("?id=req-x")).status).toBe(500);
  });

  it("pending passes through with status=pending", async () => {
    video.pollQueue.push({ requestId: "req-x", status: "pending" });
    const body = (await (await callGet("?id=req-x")).json()) as {
      phase: string;
      status: string;
    };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("pending");
  });

  it("moderation blocked surfaces status=moderation_failed", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      respectModeration: false,
    });
    const body = (await (await callGet("?id=req-x")).json()) as {
      status: string;
      success: boolean;
    };
    expect(body.status).toBe("moderation_failed");
    expect(body.success).toBe(false);
  });

  it("done + videoUrl → persists + auto-creates premiere post (default folder path)", async () => {
    video.pollQueue.push({
      requestId: "req-x",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2 * 1024 * 1024)),
      }),
    );
    fake.results.push([{ id: "p-1" }]); // random persona
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await callGet("?id=req-x&folder=premiere");
    const body = (await res.json()) as {
      phase: string;
      status: string;
      success: boolean;
      blobUrl: string;
      postId: string;
      sizeMb: string;
    };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("done");
    expect(body.blobUrl).toMatch(/^https:\/\/blob\.test\/premiere\/action\//);
    expect(Number(body.sizeMb)).toBeGreaterThan(0);

    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    const content = insert!.values.find(
      (v) => typeof v === "string" && (v as string).includes("AIGlitchPremieres"),
    );
    expect(content).toBeDefined();
  });

  it("feed folder + persona_id → feed video post attributed to given persona", async () => {
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
    fake.results.push([]); // INSERT posts (no random-persona lookup since personaId is set)
    fake.results.push([]); // UPDATE ai_personas

    const res = await callGet(
      "?id=req-x&folder=feed&persona_id=p-1&caption=hello+world",
    );
    const body = (await res.json()) as { blobUrl: string; postId: string };
    expect(body.blobUrl).toMatch(/^https:\/\/blob\.test\/feed\//);
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeDefined();
    // content is the second template slot; just verify persona_id is the specific one
    expect(insert!.values).toContain("p-1");
  });

  it("news folder → news post with AIGlitchBreaking hashtag", async () => {
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
    fake.results.push([{ id: "p-1" }]); // random persona
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE

    await callGet("?id=req-x&folder=news");
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    // news branch inlines the hashtags as a SQL literal rather than
    // binding them — check that the template contains it instead.
    expect(insert!.strings.join("?")).toContain("AIGlitchBreaking,AIGlitchNews");
  });

  it("skip_post=true → no INSERT calls", async () => {
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
    const res = await callGet("?id=req-x&folder=premiere&skip_post=true");
    const body = (await res.json()) as { blobUrl: string; postId: string | null };
    expect(body.blobUrl).toBeTruthy();
    expect(body.postId).toBeUndefined();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert).toBeUndefined();
  });

  it("expired / failed statuses pass through", async () => {
    video.pollQueue.push({ requestId: "req-x", status: "expired" });
    const body = (await (await callGet("?id=req-x")).json()) as {
      phase: string;
      status: string;
      success: boolean;
    };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("expired");
    expect(body.success).toBe(false);
  });

  it("poll exception → status=error", async () => {
    video.pollQueue.push(new Error("grok 500"));
    const body = (await (await callGet("?id=req-x")).json()) as {
      phase: string;
      status: string;
      error: string;
    };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("error");
    expect(body.error).toContain("grok 500");
  });

  it("video download failure → blobUrl null", async () => {
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
    const body = (await (await callGet("?id=req-x")).json()) as {
      blobUrl: string | null;
    };
    expect(body.blobUrl).toBeNull();
  });
});
