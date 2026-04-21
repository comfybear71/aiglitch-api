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

const img = {
  calls: [] as unknown[],
  result: {
    blobUrl: "https://blob.test/content-gen/x.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
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
    blobUrl: "https://blob.test/content-gen/x.mp4",
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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  img.calls = [];
  img.result = {
    blobUrl: "https://blob.test/content-gen/x.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
  };
  img.shouldThrow = null;
  vid.calls = [];
  vid.result = {
    blobUrl: "https://blob.test/content-gen/x.mp4",
    requestId: "req-1",
    model: "grok-imagine-video" as const,
    estimatedUsd: 0.5,
    durationSec: 10,
  };
  vid.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function call(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/content/generate", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

describe("POST /api/content/generate", () => {
  it("401 when not admin", async () => {
    expect((await call({ type: "image", prompt: "x" }, false)).status).toBe(401);
  });

  it("400 when type or prompt missing", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ type: "image" })).status).toBe(400);
    expect((await call({ prompt: "x" })).status).toBe(400);
  });

  it("400 when type is not image/video", async () => {
    expect((await call({ type: "audio", prompt: "x" })).status).toBe(400);
  });

  it("image happy path: INSERT processing → generateImageToBlob → UPDATE completed", async () => {
    fake.results.push([]); // INSERT processing
    fake.results.push([]); // UPDATE completed
    fake.results.push([
      { id: "j-1", status: "completed", result_url: img.result.blobUrl },
    ]); // SELECT

    const res = await call({ type: "image", prompt: "neon cat" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      job: { id: string; status: string };
    };
    expect(body.success).toBe(true);
    expect(body.job.status).toBe("completed");
    expect(img.calls).toHaveLength(1);
    const sent = img.calls[0] as { blobPath: string; prompt: string };
    expect(sent.prompt).toBe("neon cat");
    expect(sent.blobPath).toMatch(/^content-gen\/.*\.png$/);
  });

  it("image failure → UPDATE failed with error", async () => {
    img.shouldThrow = new Error("xAI 500");
    fake.results.push([]); // INSERT processing
    fake.results.push([]); // UPDATE failed
    fake.results.push([
      { id: "j-1", status: "failed", error: "xAI 500" },
    ]);
    const res = await call({ type: "image", prompt: "cat" });
    const body = (await res.json()) as { job: { status: string; error: string } };
    expect(body.job.status).toBe("failed");
    expect(body.job.error).toBe("xAI 500");
    // Verify an UPDATE ... status = 'failed' call landed
    const failedUpdate = fake.calls.find((c) => {
      const s = c.strings.join("?");
      return s.includes("UPDATE content_jobs") && s.includes("'failed'");
    });
    expect(failedUpdate).toBeDefined();
  });

  it("video happy path: uses generateVideoToBlob with maxAttempts=24", async () => {
    fake.results.push([]); // INSERT processing
    fake.results.push([]); // UPDATE completed
    fake.results.push([{ id: "j-1", status: "completed" }]);
    const res = await call({ type: "video", prompt: "neon chase" });
    expect(res.status).toBe(200);
    expect(vid.calls).toHaveLength(1);
    const sent = vid.calls[0] as {
      prompt: string;
      duration: number;
      aspectRatio: string;
      resolution: string;
      maxAttempts: number;
      blobPath: string;
    };
    expect(sent.prompt).toBe("neon chase");
    expect(sent.duration).toBe(10);
    expect(sent.aspectRatio).toBe("9:16");
    expect(sent.resolution).toBe("720p");
    expect(sent.maxAttempts).toBe(24);
    expect(sent.blobPath).toMatch(/^content-gen\/.*\.mp4$/);
  });

  it("video failure → UPDATE failed with error", async () => {
    vid.shouldThrow = new Error("video pipeline down");
    fake.results.push([]); // INSERT processing
    fake.results.push([]); // UPDATE failed
    fake.results.push([
      { id: "j-1", status: "failed", error: "video pipeline down" },
    ]);
    const res = await call({ type: "video", prompt: "x" });
    const body = (await res.json()) as { job: { status: string } };
    expect(body.job.status).toBe("failed");
  });
});
