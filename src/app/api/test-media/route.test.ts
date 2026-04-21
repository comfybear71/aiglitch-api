import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const img = {
  genImageCalls: [] as unknown[],
  genImageResult: {
    imageUrl: "https://xai.test/img.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
  },
  genImageThrow: null as Error | null,
  genImageToBlobCalls: [] as unknown[],
  genImageToBlobResult: {
    blobUrl: "https://blob.test/diagnostic/x.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
  },
  genImageToBlobThrow: null as Error | null,
};

vi.mock("@/lib/ai/image", () => ({
  generateImage: (opts: unknown) => {
    img.genImageCalls.push(opts);
    if (img.genImageThrow) return Promise.reject(img.genImageThrow);
    return Promise.resolve(img.genImageResult);
  },
  generateImageToBlob: (opts: unknown) => {
    img.genImageToBlobCalls.push(opts);
    if (img.genImageToBlobThrow) return Promise.reject(img.genImageToBlobThrow);
    return Promise.resolve(img.genImageToBlobResult);
  },
}));

const vid = {
  calls: [] as unknown[],
  result: {
    requestId: "req-42",
    syncVideoUrl: undefined as string | undefined,
    model: "grok-imagine-video" as const,
    estimatedUsd: 0.5,
    durationSec: 10,
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/video", () => ({
  submitVideoJob: (opts: unknown) => {
    vid.calls.push(opts);
    if (vid.shouldThrow) return Promise.reject(vid.shouldThrow);
    return Promise.resolve(vid.result);
  },
}));

beforeEach(() => {
  mockIsAdmin = false;
  img.genImageCalls = [];
  img.genImageResult = {
    imageUrl: "https://xai.test/img.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
  };
  img.genImageThrow = null;
  img.genImageToBlobCalls = [];
  img.genImageToBlobResult = {
    blobUrl: "https://blob.test/diagnostic/x.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
  };
  img.genImageToBlobThrow = null;
  vid.calls = [];
  vid.result = {
    requestId: "req-42",
    syncVideoUrl: undefined,
    model: "grok-imagine-video" as const,
    estimatedUsd: 0.5,
    durationSec: 10,
  };
  vid.shouldThrow = null;
  process.env.XAI_API_KEY = "xai-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function call(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/test-media", {
    method: "GET",
  });
  return mod.GET(req);
}

describe("GET /api/test-media", () => {
  it("401 when not admin", async () => {
    expect((await call(false)).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await call()).status).toBe(500);
  });

  it("all three steps pass → ok:true + each step ok:true with details", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      image: { ok: boolean; detail?: Record<string, unknown> };
      imageToBlob: { ok: boolean; detail?: Record<string, unknown> };
      videoSubmit: { ok: boolean; detail?: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.image.ok).toBe(true);
    expect(body.image.detail!.imageUrl).toBe("https://xai.test/img.png");
    expect(body.imageToBlob.ok).toBe(true);
    expect(body.imageToBlob.detail!.blobUrl).toBe("https://blob.test/diagnostic/x.png");
    expect(body.videoSubmit.ok).toBe(true);
    expect(body.videoSubmit.detail!.requestId).toBe("req-42");
  });

  it("one failure → ok:false, other steps still report success", async () => {
    vid.shouldThrow = new Error("video 500");
    const res = await call();
    const body = (await res.json()) as {
      ok: boolean;
      image: { ok: boolean };
      imageToBlob: { ok: boolean };
      videoSubmit: { ok: boolean; error?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.image.ok).toBe(true);
    expect(body.imageToBlob.ok).toBe(true);
    expect(body.videoSubmit.ok).toBe(false);
    expect(body.videoSubmit.error).toContain("video 500");
  });

  it("all three fail → each captures error independently", async () => {
    img.genImageThrow = new Error("image 500");
    img.genImageToBlobThrow = new Error("blob 500");
    vid.shouldThrow = new Error("video 500");
    const res = await call();
    const body = (await res.json()) as {
      ok: boolean;
      image: { ok: boolean; error?: string };
      imageToBlob: { ok: boolean; error?: string };
      videoSubmit: { ok: boolean; error?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.image.error).toBe("image 500");
    expect(body.imageToBlob.error).toBe("blob 500");
    expect(body.videoSubmit.error).toBe("video 500");
  });

  it("imageToBlob uses 1:1 aspect + diagnostic blobPath", async () => {
    await call();
    const sent = img.genImageToBlobCalls[0] as {
      aspectRatio: string;
      blobPath: string;
    };
    expect(sent.aspectRatio).toBe("1:1");
    expect(sent.blobPath).toMatch(/^diagnostic\/media-\d+\.png$/);
  });

  it("submitVideoJob uses 10s 9:16 720p", async () => {
    await call();
    const sent = vid.calls[0] as {
      duration: number;
      aspectRatio: string;
      resolution: string;
    };
    expect(sent.duration).toBe(10);
    expect(sent.aspectRatio).toBe("9:16");
    expect(sent.resolution).toBe("720p");
  });

  it("syncVideoUrl propagates when xAI returns inline", async () => {
    vid.result = {
      ...vid.result,
      syncVideoUrl: "https://xai.test/v.mp4",
    };
    const res = await call();
    const body = (await res.json()) as {
      videoSubmit: { detail?: { syncVideoUrl: string | null } };
    };
    expect(body.videoSubmit.detail!.syncVideoUrl).toBe("https://xai.test/v.mp4");
  });
});
