/**
 * Tests for the HeyGen Avatar V client.
 *
 * Same fetch-queue + blob-stub pattern as video.test.ts. Polling
 * intervals are forced to 0 so tests don't sleep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResult: { url: "https://blob.test/anchor.mp4" } as { url: string },
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
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
  blob.putResult = { url: "https://blob.test/anchor.mp4" };
  vi.stubGlobal("fetch", fetchMock);
  process.env.HEYGEN_API_KEY = "test-heygen-key";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.DATABASE_URL;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HEYGEN_API_KEY;
  vi.unstubAllGlobals();
});

function okJson(body: unknown): FetchResponseShape {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
function okBytes(bytes: Uint8Array): FetchResponseShape {
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
    headers: new Headers({ "content-type": "video/mp4" }),
  };
}
function badStatus(status: number, text = ""): FetchResponseShape {
  return { ok: false, status, text: () => Promise.resolve(text) };
}

describe("submitAvatarJob", () => {
  it("throws when HEYGEN_API_KEY is missing", async () => {
    delete process.env.HEYGEN_API_KEY;
    const { submitAvatarJob } = await import("./heygen");
    await expect(
      submitAvatarJob({
        script: "Breaking news today.",
        avatarId: "av-1",
        voiceId: "vc-1",
        taskType: "video_generation",
      }),
    ).rejects.toThrow(/HEYGEN_API_KEY not set/);
  });

  it("POSTs /v3/videos with avatar + voice + script + 9:16 default", async () => {
    fetchQueue.push(okJson({ data: { video_id: "vid-1" } }));
    const { submitAvatarJob } = await import("./heygen");
    const res = await submitAvatarJob({
      script: "Breaking news from GNN.",
      avatarId: "anchor-1",
      voiceId: "voice-1",
      taskType: "video_generation",
    });
    expect(res.videoId).toBe("vid-1");

    expect(fetchCalls[0]!.url).toBe("https://api.heygen.com/v3/videos");
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-heygen-key");

    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as {
      type: string;
      avatar_id: string;
      voice_id: string;
      script: string;
      aspect_ratio: string;
      engine: { type: string };
    };
    expect(body.type).toBe("avatar");
    expect(body.avatar_id).toBe("anchor-1");
    expect(body.voice_id).toBe("voice-1");
    expect(body.script).toBe("Breaking news from GNN.");
    expect(body.aspect_ratio).toBe("9:16");
    expect(body.engine.type).toBe("avatar_v");
  });

  it("throws when submit response omits video_id", async () => {
    fetchQueue.push(okJson({ data: {} }));
    const { submitAvatarJob } = await import("./heygen");
    await expect(
      submitAvatarJob({
        script: "x",
        avatarId: "a",
        voiceId: "v",
        taskType: "video_generation",
      }),
    ).rejects.toThrow(/missing video_id/);
  });

  it("throws with status code on non-OK response", async () => {
    fetchQueue.push(badStatus(402, "out of credit"));
    const { submitAvatarJob } = await import("./heygen");
    await expect(
      submitAvatarJob({
        script: "x",
        avatarId: "a",
        voiceId: "v",
        taskType: "video_generation",
      }),
    ).rejects.toThrow(/HeyGen video submit failed \(402\): out of credit/);
  });
});

describe("pollAvatarJob", () => {
  it("GETs /v1/video_status.get with the video id and returns status", async () => {
    fetchQueue.push(
      okJson({
        data: {
          status: "completed",
          video_url: "https://heygen.test/done.mp4",
          duration: 10.5,
        },
      }),
    );
    const { pollAvatarJob } = await import("./heygen");
    const res = await pollAvatarJob("vid-2");
    expect(res.status).toBe("completed");
    expect(res.videoUrl).toBe("https://heygen.test/done.mp4");
    expect(res.durationSec).toBe(10.5);
    expect(fetchCalls[0]!.url).toBe(
      "https://api.heygen.com/v1/video_status.get?video_id=vid-2",
    );
  });

  it("maps processing/failed correctly and surfaces error message", async () => {
    fetchQueue.push(
      okJson({
        data: { status: "failed", error: { message: "voice unknown" } },
      }),
    );
    const { pollAvatarJob } = await import("./heygen");
    const res = await pollAvatarJob("vid-3");
    expect(res.status).toBe("failed");
    expect(res.error).toBe("voice unknown");
  });
});

describe("generateAvatarVideo — submit + poll + cost", () => {
  it("logs estimated cost from returned duration and Avatar V rate", async () => {
    fetchQueue.push(okJson({ data: { video_id: "vid-4" } })); // submit
    fetchQueue.push(
      okJson({
        data: {
          status: "completed",
          video_url: "https://heygen.test/v4.mp4",
          duration: 12,
        },
      }),
    ); // first poll
    const { generateAvatarVideo, HEYGEN_AVATAR_V_USD_PER_SECOND } =
      await import("./heygen");
    const res = await generateAvatarVideo({
      script: "test news",
      avatarId: "a",
      voiceId: "v",
      taskType: "video_generation",
      pollIntervalMs: 0,
    });
    expect(res.videoUrl).toBe("https://heygen.test/v4.mp4");
    expect(res.durationSec).toBe(12);
    expect(res.estimatedUsd).toBeCloseTo(
      12 * HEYGEN_AVATAR_V_USD_PER_SECOND,
      6,
    );
    // 12s × $0.0167/sec = $0.20
    expect(res.estimatedUsd).toBeCloseTo(0.2, 2);
  });

  it("throws on terminal failure status", async () => {
    fetchQueue.push(okJson({ data: { video_id: "vid-5" } }));
    fetchQueue.push(
      okJson({
        data: {
          status: "failed",
          error: { message: "render error" },
        },
      }),
    );
    const { generateAvatarVideo } = await import("./heygen");
    await expect(
      generateAvatarVideo({
        script: "x",
        avatarId: "a",
        voiceId: "v",
        taskType: "video_generation",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/HeyGen video vid-5 failed: render error/);
  });

  it("times out after maxAttempts polls", async () => {
    fetchQueue.push(okJson({ data: { video_id: "vid-6" } }));
    // Three polls all returning processing
    for (let i = 0; i < 3; i++) {
      fetchQueue.push(okJson({ data: { status: "processing" } }));
    }
    const { generateAvatarVideo } = await import("./heygen");
    await expect(
      generateAvatarVideo({
        script: "x",
        avatarId: "a",
        voiceId: "v",
        taskType: "video_generation",
        pollIntervalMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/timed out after 3 polls/);
  });
});

describe("generateAvatarVideoToBlob — full path with Vercel Blob put", () => {
  it("downloads the HeyGen URL and uploads bytes to Vercel Blob", async () => {
    fetchQueue.push(okJson({ data: { video_id: "vid-7" } })); // submit
    fetchQueue.push(
      okJson({
        data: {
          status: "completed",
          video_url: "https://heygen.test/v7.mp4",
          duration: 10,
        },
      }),
    ); // poll
    fetchQueue.push(okBytes(new Uint8Array([1, 2, 3, 4]))); // download

    const { generateAvatarVideoToBlob } = await import("./heygen");
    const res = await generateAvatarVideoToBlob({
      script: "news",
      avatarId: "a",
      voiceId: "v",
      taskType: "video_generation",
      pollIntervalMs: 0,
      blobPath: "breaking-news/stitched/2026-06-09/topic-1.mp4",
    });
    expect(res.blobUrl).toBe("https://blob.test/anchor.mp4");
    expect(res.sizeBytes).toBe(4);
    expect(blob.putCalls[0]!.pathname).toBe(
      "breaking-news/stitched/2026-06-09/topic-1.mp4",
    );
  });
});

describe("isHeyGenConfigured", () => {
  it("true only when HEYGEN_API_KEY is set", async () => {
    const { isHeyGenConfigured } = await import("./heygen");
    expect(isHeyGenConfigured()).toBe(true);
    delete process.env.HEYGEN_API_KEY;
    expect(isHeyGenConfigured()).toBe(false);
  });
});
