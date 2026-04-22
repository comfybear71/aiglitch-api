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
        estimatedUsd: 0.25,
        durationSec: 5,
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
    "http://localhost/api/admin/channels/generate-title",
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
    `http://localhost/api/admin/channels/generate-title${query}`,
    { method: "GET" },
  );
  return mod.GET(req);
}

describe("POST /api/admin/channels/generate-title", () => {
  it("401 when not admin", async () => {
    expect((await callPost({}, false)).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    const res = await callPost({
      channel_id: "c",
      channel_slug: "s",
      title: "T",
    });
    expect(res.status).toBe(500);
  });

  it("400 when required fields missing", async () => {
    expect((await callPost({})).status).toBe(400);
    expect((await callPost({ channel_id: "c" })).status).toBe(400);
  });

  it("preview mode returns the prompt without submitting", async () => {
    const res = await callPost({
      channel_id: "c",
      channel_slug: "ai-news",
      title: "ai news",
      preview: true,
    });
    const body = (await res.json()) as {
      ok: boolean;
      prompt: string;
      title: string;
    };
    expect(body.ok).toBe(true);
    expect(body.title).toBe("AI NEWS");
    expect(body.prompt).toContain("AI NEWS");
    expect(body.prompt).toContain("A-I- -N-E-W-S"); // letter-by-letter
    expect(video.submitCalls).toHaveLength(0);
  });

  it("happy path submit with default style", async () => {
    const res = await callPost({
      channel_id: "ch-news",
      channel_slug: "ai-news",
      title: "BREAKING",
    });
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      requestId: string;
      channelSlug: string;
      title: string;
    };
    expect(body.phase).toBe("submitted");
    expect(body.requestId).toBe("req-1");
    expect(body.channelSlug).toBe("ai-news");
    expect(body.title).toBe("BREAKING");

    const sent = video.submitCalls[0] as {
      prompt: string;
      duration: number;
      aspectRatio: string;
      resolution: string;
    };
    expect(sent.duration).toBe(5);
    expect(sent.aspectRatio).toBe("9:16");
    expect(sent.resolution).toBe("720p");
    expect(sent.prompt).toContain("BREAKING");
    expect(sent.prompt).toContain("glowing neon");
  });

  it("style_prompt override replaces default style block", async () => {
    await callPost({
      channel_id: "c",
      channel_slug: "s",
      title: "X",
      style_prompt: "vaporwave pink palette",
    });
    const sent = video.submitCalls[0] as { prompt: string };
    expect(sent.prompt).toContain("vaporwave pink palette");
    expect(sent.prompt).not.toContain("glowing neon");
  });

  it("sync video URL persists immediately + updates channel row", async () => {
    video.submitQueue.push({
      requestId: "req-sync",
      syncVideoUrl: "https://grok.ai/title.mp4",
      model: "grok-imagine-video",
      estimatedUsd: 0.25,
      durationSec: 5,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      }),
    );
    fake.results.push([]); // UPDATE channels
    const res = await callPost({
      channel_id: "c",
      channel_slug: "s",
      title: "X",
    });
    const body = (await res.json()) as {
      phase: string;
      success: boolean;
      blobUrl: string;
    };
    expect(body.phase).toBe("done");
    expect(body.blobUrl).toMatch(/^https:\/\/blob\.test\/channels\/s\/title-/);
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE channels"),
    );
    expect(update).toBeDefined();
  });

  it("submit error → phase=submit with error", async () => {
    video.submitQueue.push(new Error("xAI 500"));
    const res = await callPost({
      channel_id: "c",
      channel_slug: "s",
      title: "X",
    });
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

describe("GET /api/admin/channels/generate-title", () => {
  it("401 when not admin", async () => {
    expect(
      (await callGet("?id=r&channel_id=c&channel_slug=s", false)).status,
    ).toBe(401);
  });

  it("400 when any of id/channel_id/channel_slug missing", async () => {
    expect((await callGet("?id=r&channel_id=c")).status).toBe(400);
    expect((await callGet("?channel_id=c&channel_slug=s")).status).toBe(400);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await callGet("?id=r&channel_id=c&channel_slug=s")).status).toBe(500);
  });

  it("pending passes through", async () => {
    video.pollQueue.push({ requestId: "r", status: "pending" });
    const body = (await (
      await callGet("?id=r&channel_id=c&channel_slug=s")
    ).json()) as { phase: string; status: string };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("pending");
  });

  it("moderation blocked surfaces moderation_failed", async () => {
    video.pollQueue.push({
      requestId: "r",
      status: "done",
      respectModeration: false,
    });
    const body = (await (
      await callGet("?id=r&channel_id=c&channel_slug=s")
    ).json()) as { status: string; success: boolean };
    expect(body.status).toBe("moderation_failed");
    expect(body.success).toBe(false);
  });

  it("done + videoUrl → persist + update channel row", async () => {
    video.pollQueue.push({
      requestId: "r",
      status: "done",
      videoUrl: "https://grok.ai/t.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      }),
    );
    fake.results.push([]); // UPDATE channels
    const res = await callGet("?id=r&channel_id=ch-news&channel_slug=ai-news");
    const body = (await res.json()) as {
      phase: string;
      status: string;
      blobUrl: string;
    };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("done");
    expect(body.blobUrl).toMatch(/^https:\/\/blob\.test\/channels\/ai-news\/title-/);
  });

  it("expired / failed pass through", async () => {
    video.pollQueue.push({ requestId: "r", status: "expired" });
    const body = (await (
      await callGet("?id=r&channel_id=c&channel_slug=s")
    ).json()) as { phase: string; status: string; success: boolean };
    expect(body.phase).toBe("done");
    expect(body.status).toBe("expired");
    expect(body.success).toBe(false);
  });

  it("poll exception surfaces error", async () => {
    video.pollQueue.push(new Error("grok 500"));
    const body = (await (
      await callGet("?id=r&channel_id=c&channel_slug=s")
    ).json()) as { phase: string; status: string; error: string };
    expect(body.phase).toBe("poll");
    expect(body.status).toBe("error");
    expect(body.error).toContain("grok 500");
  });

  it("video download failure → blobUrl null, status still 'done'", async () => {
    video.pollQueue.push({
      requestId: "r",
      status: "done",
      videoUrl: "https://grok.ai/t.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );
    const body = (await (
      await callGet("?id=r&channel_id=c&channel_slug=s")
    ).json()) as { status: string; blobUrl: string | null };
    expect(body.status).toBe("done");
    expect(body.blobUrl).toBeNull();
  });
});
