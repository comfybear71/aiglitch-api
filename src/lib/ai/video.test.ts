import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────
//
// Circuit breaker + cost ledger: real modules — no UPSTASH / DATABASE_URL →
// fail-open → no-op. Same pattern as image.test.ts.
//
// @vercel/blob: stubbed. Polling: driven by the fake fetch queue below with
// a 0ms poll interval.

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResult: { url: "https://blob.test/default.mp4" } as { url: string },
  putShouldThrow: null as Error | null,
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    if (blob.putShouldThrow) return Promise.reject(blob.putShouldThrow);
    return Promise.resolve(blob.putResult);
  },
}));

type FetchResponseShape = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: Headers;
};

const fetchQueue: (FetchResponseShape | Error)[] = [];
const fetchCalls: { url: string; init?: RequestInit }[] = [];

const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init });
  const next = fetchQueue.shift();
  if (!next) throw new Error(`fetch queue empty — url=${String(url)}`);
  if (next instanceof Error) throw next;
  return next as unknown as Response;
});

beforeEach(() => {
  fetchQueue.length = 0;
  fetchCalls.length = 0;
  fetchMock.mockClear();
  blob.putCalls = [];
  blob.putResult = { url: "https://blob.test/default.mp4" };
  blob.putShouldThrow = null;
  vi.stubGlobal("fetch", fetchMock);
  process.env.XAI_API_KEY = "test-xai-key";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.DATABASE_URL;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.unstubAllGlobals();
});

function okJson(body: unknown): FetchResponseShape {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function okBytes(bytes: Uint8Array, contentType = "video/mp4"): FetchResponseShape {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      ),
    headers: new Headers({ "content-type": contentType }),
  };
}

function badStatus(status: number, text = ""): FetchResponseShape {
  return { ok: false, status, text: () => Promise.resolve(text) };
}

describe("submitVideoJob", () => {
  it("throws when XAI_API_KEY is missing", async () => {
    delete process.env.XAI_API_KEY;
    const { submitVideoJob } = await import("./video");
    await expect(
      submitVideoJob({ prompt: "a glitch", taskType: "video_generation" }),
    ).rejects.toThrow(/XAI_API_KEY not set/);
  });

  it("POSTs to /videos/generations with default duration + resolution", async () => {
    fetchQueue.push(okJson({ request_id: "req-1" }));
    const { submitVideoJob } = await import("./video");
    const res = await submitVideoJob({
      prompt: "rain on neon",
      taskType: "video_generation",
    });
    expect(res.requestId).toBe("req-1");
    expect(res.durationSec).toBe(10);
    expect(res.estimatedUsd).toBeCloseTo(0.5, 6);
    expect(res.model).toBe("grok-imagine-video");

    expect(fetchCalls[0]!.url).toBe("https://api.x.ai/v1/videos/generations");
    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as {
      model: string;
      prompt: string;
      duration: number;
      resolution: string;
      aspect_ratio?: string;
      image_url?: string;
    };
    expect(body.model).toBe("grok-imagine-video");
    expect(body.duration).toBe(10);
    expect(body.resolution).toBe("720p");
    expect(body.aspect_ratio).toBeUndefined();
    expect(body.image_url).toBeUndefined();
  });

  it("honours duration + aspect + resolution overrides and prices correctly", async () => {
    fetchQueue.push(okJson({ request_id: "req-2" }));
    const { submitVideoJob } = await import("./video");
    const res = await submitVideoJob({
      prompt: "x",
      taskType: "video_generation",
      duration: 5,
      aspectRatio: "9:16",
      resolution: "1080p",
    });
    expect(res.durationSec).toBe(5);
    expect(res.estimatedUsd).toBeCloseTo(0.25, 6);
    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as {
      duration: number;
      aspect_ratio: string;
      resolution: string;
    };
    expect(body.duration).toBe(5);
    expect(body.aspect_ratio).toBe("9:16");
    expect(body.resolution).toBe("1080p");
  });

  it("passes image_url through for image-to-video jobs", async () => {
    fetchQueue.push(okJson({ request_id: "req-3" }));
    const { submitVideoJob } = await import("./video");
    await submitVideoJob({
      prompt: "animate this",
      taskType: "video_generation",
      sourceImageUrl: "https://cdn.test/frame.png",
    });
    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as {
      image_url: string;
    };
    expect(body.image_url).toBe("https://cdn.test/frame.png");
  });

  it("captures a synchronous video URL when xAI returns one on submit", async () => {
    fetchQueue.push(
      okJson({ request_id: "req-4", video: { url: "https://xai.test/sync.mp4" } }),
    );
    const { submitVideoJob } = await import("./video");
    const res = await submitVideoJob({
      prompt: "x",
      taskType: "video_generation",
    });
    expect(res.requestId).toBe("req-4");
    expect(res.syncVideoUrl).toBe("https://xai.test/sync.mp4");
  });

  it("throws on non-OK submit response", async () => {
    fetchQueue.push(badStatus(500, "upstream boom"));
    const { submitVideoJob } = await import("./video");
    await expect(
      submitVideoJob({ prompt: "x", taskType: "video_generation" }),
    ).rejects.toThrow(/xAI video submit failed \(500\): upstream boom/);
  });

  it("throws when the response carries neither request_id nor video url", async () => {
    fetchQueue.push(okJson({}));
    const { submitVideoJob } = await import("./video");
    await expect(
      submitVideoJob({ prompt: "x", taskType: "video_generation" }),
    ).rejects.toThrow(/missing request_id \+ video/);
  });
});

describe("pollVideoJob", () => {
  it("GETs /videos/{id} and returns the status + url", async () => {
    fetchQueue.push(
      okJson({
        status: "done",
        video: { url: "https://xai.test/done.mp4" },
        respect_moderation: true,
      }),
    );
    const { pollVideoJob } = await import("./video");
    const res = await pollVideoJob("req-5");
    expect(res.status).toBe("done");
    expect(res.videoUrl).toBe("https://xai.test/done.mp4");
    expect(res.respectModeration).toBe(true);
    expect(fetchCalls[0]!.url).toBe("https://api.x.ai/v1/videos/req-5");
    expect(fetchCalls[0]!.init?.method).toBe("GET");
  });

  it("defaults to pending when the response omits status", async () => {
    fetchQueue.push(okJson({}));
    const { pollVideoJob } = await import("./video");
    const res = await pollVideoJob("req-6");
    expect(res.status).toBe("pending");
    expect(res.videoUrl).toBeUndefined();
  });

  it("throws on non-OK poll response", async () => {
    fetchQueue.push(badStatus(404, "gone"));
    const { pollVideoJob } = await import("./video");
    await expect(pollVideoJob("req-7")).rejects.toThrow(
      /xAI video poll failed \(404\): gone/,
    );
  });
});

describe("generateVideo", () => {
  it("short-circuits when submit returns a synchronous video url", async () => {
    fetchQueue.push(
      okJson({ request_id: "sync-req", video: { url: "https://xai.test/sync.mp4" } }),
    );
    const { generateVideo } = await import("./video");
    const res = await generateVideo({
      prompt: "x",
      taskType: "video_generation",
      pollIntervalMs: 0,
    });
    expect(res.videoUrl).toBe("https://xai.test/sync.mp4");
    // Only the submit fetch — no poll.
    expect(fetchCalls).toHaveLength(1);
  });

  it("polls until status=done and returns the video URL", async () => {
    fetchQueue.push(okJson({ request_id: "req-8" }));
    fetchQueue.push(okJson({ status: "pending" }));
    fetchQueue.push(okJson({ status: "pending" }));
    fetchQueue.push(
      okJson({
        status: "done",
        video: { url: "https://xai.test/ready.mp4" },
      }),
    );
    const { generateVideo } = await import("./video");
    const res = await generateVideo({
      prompt: "x",
      taskType: "video_generation",
      pollIntervalMs: 0,
    });
    expect(res.videoUrl).toBe("https://xai.test/ready.mp4");
    expect(res.requestId).toBe("req-8");
    // 1 submit + 3 polls.
    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls[1]!.url).toBe("https://api.x.ai/v1/videos/req-8");
  });

  it("throws when polled status comes back as failed", async () => {
    fetchQueue.push(okJson({ request_id: "req-9" }));
    fetchQueue.push(okJson({ status: "failed" }));
    const { generateVideo } = await import("./video");
    await expect(
      generateVideo({
        prompt: "x",
        taskType: "video_generation",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/req-9 failed/);
  });

  it("throws when polled status comes back as expired", async () => {
    fetchQueue.push(okJson({ request_id: "req-10" }));
    fetchQueue.push(okJson({ status: "expired" }));
    const { generateVideo } = await import("./video");
    await expect(
      generateVideo({
        prompt: "x",
        taskType: "video_generation",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/req-10 expired/);
  });

  it("throws when a done response is missing the video url", async () => {
    fetchQueue.push(okJson({ request_id: "req-11" }));
    fetchQueue.push(okJson({ status: "done" }));
    const { generateVideo } = await import("./video");
    await expect(
      generateVideo({
        prompt: "x",
        taskType: "video_generation",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/done but missing url/);
  });

  it("throws when moderation blocks a completed video", async () => {
    fetchQueue.push(okJson({ request_id: "req-12" }));
    fetchQueue.push(
      okJson({
        status: "done",
        video: { url: "https://xai.test/blocked.mp4" },
        respect_moderation: false,
      }),
    );
    const { generateVideo } = await import("./video");
    await expect(
      generateVideo({
        prompt: "x",
        taskType: "video_generation",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/req-12 blocked by moderation/);
  });

  it("throws after maxAttempts when status never resolves", async () => {
    fetchQueue.push(okJson({ request_id: "req-13" }));
    fetchQueue.push(okJson({ status: "pending" }));
    fetchQueue.push(okJson({ status: "pending" }));
    const { generateVideo } = await import("./video");
    await expect(
      generateVideo({
        prompt: "x",
        taskType: "video_generation",
        pollIntervalMs: 0,
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/still pending after 2 attempts/);
  });
});

describe("generateVideoToBlob", () => {
  it("downloads the completed video and uploads to Vercel Blob", async () => {
    fetchQueue.push(okJson({ request_id: "req-14" }));
    fetchQueue.push(
      okJson({
        status: "done",
        video: { url: "https://xai.test/ready.mp4" },
      }),
    );
    fetchQueue.push(okBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef])));
    blob.putResult = { url: "https://blob.test/hatch/persona.mp4" };
    const { generateVideoToBlob } = await import("./video");
    const res = await generateVideoToBlob({
      prompt: "x",
      taskType: "video_generation",
      pollIntervalMs: 0,
      blobPath: "hatch/persona.mp4",
    });
    expect(res.blobUrl).toBe("https://blob.test/hatch/persona.mp4");
    expect(res.requestId).toBe("req-14");
    expect(res.sizeBytes).toBe(4);
    expect(blob.putCalls).toHaveLength(1);
    const putCall = blob.putCalls[0]!;
    expect(putCall.pathname).toBe("hatch/persona.mp4");
    const opts = putCall.opts as {
      access: string;
      contentType: string;
      addRandomSuffix: boolean;
    };
    expect(opts.access).toBe("public");
    expect(opts.addRandomSuffix).toBe(false);
    expect(opts.contentType).toBe("video/mp4");
  });

  it("honours an explicit contentType over the response header", async () => {
    fetchQueue.push(okJson({ request_id: "req-15" }));
    fetchQueue.push(
      okJson({ status: "done", video: { url: "https://xai.test/x.webm" } }),
    );
    fetchQueue.push(okBytes(new Uint8Array([1]), "application/octet-stream"));
    const { generateVideoToBlob } = await import("./video");
    await generateVideoToBlob({
      prompt: "x",
      taskType: "video_generation",
      pollIntervalMs: 0,
      blobPath: "x/y.mp4",
      contentType: "video/mp4",
    });
    const opts = blob.putCalls[0]!.opts as { contentType: string };
    expect(opts.contentType).toBe("video/mp4");
  });

  it("throws if the video download fails", async () => {
    fetchQueue.push(okJson({ request_id: "req-16" }));
    fetchQueue.push(
      okJson({ status: "done", video: { url: "https://xai.test/x.mp4" } }),
    );
    fetchQueue.push(badStatus(404));
    const { generateVideoToBlob } = await import("./video");
    await expect(
      generateVideoToBlob({
        prompt: "x",
        taskType: "video_generation",
        pollIntervalMs: 0,
        blobPath: "x/y.mp4",
      }),
    ).rejects.toThrow(/Failed to download xAI video \(404\)/);
    expect(blob.putCalls).toHaveLength(0);
  });
});
