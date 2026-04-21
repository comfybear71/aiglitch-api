import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────
//
// Circuit breaker + cost ledger: real modules are fine — Redis and Neon are
// unconfigured in tests, so every function no-ops (fail-open). That gives
// us integration-style coverage without needing to stub the internals.
//
// @vercel/blob: stubbed so we can assert upload behaviour + inject errors.

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResult: { url: "" } as { url: string },
  putShouldThrow: null as Error | null,
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    if (blob.putShouldThrow) return Promise.reject(blob.putShouldThrow);
    return Promise.resolve(blob.putResult);
  },
}));

// ── Fetch queue helper ────────────────────────────────────────────────────
//
// Queue a sequence of Response-like objects. `generateImage` makes ONE
// fetch (to xAI). `generateImageToBlob` makes TWO (xAI, then download the
// ephemeral URL). Push in call order.

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
  blob.putResult = { url: "https://blob.test/default.png" };
  blob.putShouldThrow = null;
  vi.stubGlobal("fetch", fetchMock);
  process.env.XAI_API_KEY = "test-xai-key";
  // No UPSTASH_* → breaker fail-open. No DATABASE_URL → logAiCost no-op.
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

function okBytes(bytes: Uint8Array, contentType = "image/png"): FetchResponseShape {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    headers: new Headers({ "content-type": contentType }),
  };
}

function badStatus(status: number, text = ""): FetchResponseShape {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(text),
  };
}

describe("generateImage", () => {
  it("throws when XAI_API_KEY is missing", async () => {
    delete process.env.XAI_API_KEY;
    const { generateImage } = await import("./image");
    await expect(
      generateImage({ prompt: "a glitch hat", taskType: "image_generation" }),
    ).rejects.toThrow(/XAI_API_KEY not set/);
  });

  it("POSTs to /images/generations with the default model and no aspect_ratio", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/ephem.png" }] }));
    const { generateImage } = await import("./image");
    const result = await generateImage({
      prompt: "a cyberpunk sticker",
      taskType: "image_generation",
    });
    expect(result.imageUrl).toBe("https://grok.test/ephem.png");
    expect(result.model).toBe("grok-imagine-image");
    expect(result.estimatedUsd).toBe(0.02);

    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/images/generations");
    const body = JSON.parse(call.init?.body as string) as {
      model: string;
      prompt: string;
      n: number;
      aspect_ratio?: string;
    };
    expect(body.model).toBe("grok-imagine-image");
    expect(body.prompt).toBe("a cyberpunk sticker");
    expect(body.n).toBe(1);
    expect(body.aspect_ratio).toBeUndefined();
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-xai-key");
  });

  it("uses the pro model at $0.07 when requested", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/pro.png" }] }));
    const { generateImage } = await import("./image");
    const result = await generateImage({
      prompt: "premium",
      taskType: "image_generation",
      model: "grok-imagine-image-pro",
    });
    expect(result.estimatedUsd).toBe(0.07);
    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as { model: string };
    expect(body.model).toBe("grok-imagine-image-pro");
  });

  it("passes aspect_ratio through when provided", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/wide.png" }] }));
    const { generateImage } = await import("./image");
    await generateImage({
      prompt: "tall",
      taskType: "image_generation",
      aspectRatio: "9:16",
    });
    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as { aspect_ratio: string };
    expect(body.aspect_ratio).toBe("9:16");
  });

  it("routes to /images/edits when sourceImageUrls is set", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/edit.png" }] }));
    const { generateImage } = await import("./image");
    await generateImage({
      prompt: "remix",
      taskType: "image_generation",
      sourceImageUrls: ["https://ref.test/a.png", "https://ref.test/b.png"],
    });
    expect(fetchCalls[0]!.url).toBe("https://api.x.ai/v1/images/edits");
    const body = JSON.parse(fetchCalls[0]!.init?.body as string) as {
      images: { url: string }[];
    };
    expect(body.images).toEqual([
      { url: "https://ref.test/a.png" },
      { url: "https://ref.test/b.png" },
    ]);
  });

  it("throws with a descriptive message when xAI returns a non-OK status", async () => {
    fetchQueue.push(badStatus(500, "upstream boom"));
    const { generateImage } = await import("./image");
    await expect(
      generateImage({ prompt: "x", taskType: "image_generation" }),
    ).rejects.toThrow(/xAI image gen failed \(500\): upstream boom/);
  });

  it("throws when the response contains no URL", async () => {
    fetchQueue.push(okJson({ data: [] }));
    const { generateImage } = await import("./image");
    await expect(
      generateImage({ prompt: "x", taskType: "image_generation" }),
    ).rejects.toThrow(/no URL in response/);
  });
});

describe("generateImageToBlob", () => {
  it("downloads the ephemeral URL and uploads to the provided blob path", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/raw.png" }] }));
    fetchQueue.push(okBytes(new Uint8Array([1, 2, 3, 4])));
    blob.putResult = { url: "https://blob.test/merch/designs/abc.png" };

    const { generateImageToBlob } = await import("./image");
    const res = await generateImageToBlob({
      prompt: "a shirt",
      taskType: "image_generation",
      blobPath: "merch/designs/abc.png",
    });
    expect(res.blobUrl).toBe("https://blob.test/merch/designs/abc.png");
    expect(res.model).toBe("grok-imagine-image");
    expect(res.estimatedUsd).toBe(0.02);

    // Second fetch is the download of the ephemeral URL.
    expect(fetchCalls[1]!.url).toBe("https://grok.test/raw.png");

    expect(blob.putCalls).toHaveLength(1);
    const putCall = blob.putCalls[0]!;
    expect(putCall.pathname).toBe("merch/designs/abc.png");
    const opts = putCall.opts as { access: string; contentType: string; addRandomSuffix: boolean };
    expect(opts.access).toBe("public");
    expect(opts.addRandomSuffix).toBe(false);
    expect(opts.contentType).toBe("image/png");
  });

  it("uses the response content-type when the caller doesn't override it", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/raw.jpg" }] }));
    fetchQueue.push(okBytes(new Uint8Array([5]), "image/jpeg"));
    const { generateImageToBlob } = await import("./image");
    await generateImageToBlob({
      prompt: "x",
      taskType: "image_generation",
      blobPath: "x/y.jpg",
    });
    const opts = blob.putCalls[0]!.opts as { contentType: string };
    expect(opts.contentType).toBe("image/jpeg");
  });

  it("honours an explicit contentType over the response header", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/raw" }] }));
    fetchQueue.push(okBytes(new Uint8Array([1]), "application/octet-stream"));
    const { generateImageToBlob } = await import("./image");
    await generateImageToBlob({
      prompt: "x",
      taskType: "image_generation",
      blobPath: "x/y.png",
      contentType: "image/png",
    });
    const opts = blob.putCalls[0]!.opts as { contentType: string };
    expect(opts.contentType).toBe("image/png");
  });

  it("throws if the download fetch fails", async () => {
    fetchQueue.push(okJson({ data: [{ url: "https://grok.test/raw.png" }] }));
    fetchQueue.push(badStatus(404));
    const { generateImageToBlob } = await import("./image");
    await expect(
      generateImageToBlob({
        prompt: "x",
        taskType: "image_generation",
        blobPath: "x/y.png",
      }),
    ).rejects.toThrow(/Failed to download xAI image \(404\)/);
    expect(blob.putCalls).toHaveLength(0);
  });
});
