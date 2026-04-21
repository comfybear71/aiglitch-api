import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const imageGen = {
  calls: [] as {
    prompt: string;
    blobPath: string;
    model?: string;
    aspectRatio?: string;
  }[],
  // Per-call queue — defaults to success when empty so tests can mix
  // explicit failures with default-happy rows.
  queue: [] as (
    | { blobUrl: string; model: "grok-imagine-image-pro"; estimatedUsd: number }
    | Error
  )[],
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: {
    prompt: string;
    blobPath: string;
    model?: string;
    aspectRatio?: string;
  }) => {
    imageGen.calls.push(opts);
    const next = imageGen.queue.shift();
    if (!next) {
      return Promise.resolve({
        blobUrl: `https://blob.test/${opts.blobPath}`,
        model: "grok-imagine-image-pro" as const,
        estimatedUsd: 0.07,
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

beforeEach(() => {
  mockIsAdmin = false;
  imageGen.calls = [];
  imageGen.queue = [];
  vi.resetModules();
});

afterEach(() => {
  // Nothing — helper fully mocked.
});

async function call(method: "GET" | "POST", body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/generate-og-images", init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/generate-og-images", () => {
  it("401 when not admin", async () => {
    const res = await call("GET");
    expect(res.status).toBe(401);
  });

  it("returns the generator HTML when admin", async () => {
    mockIsAdmin = true;
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>OG Image Generator</title>");
    expect(html).toContain("og-default");
    expect(html).toContain("og-channels");
    expect(html).toContain("og-marketplace-qvc");
    // Generate-all button + price quote derived from pro pricing x 21.
    expect(html).toContain("Generate All 21 Images");
  });
});

describe("POST /api/admin/generate-og-images — validation", () => {
  it("401 when not admin", async () => {
    const res = await call("POST", { file: "og-default" });
    expect(res.status).toBe(401);
    expect(imageGen.calls).toHaveLength(0);
  });

  it("400 when file does not match any known slug", async () => {
    mockIsAdmin = true;
    const res = await call("POST", { file: "og-not-a-thing" });
    expect(res.status).toBe(400);
    expect(imageGen.calls).toHaveLength(0);
  });
});

describe("POST /api/admin/generate-og-images — single-file path", () => {
  it("generates one image when file is specified", async () => {
    mockIsAdmin = true;
    const res = await call("POST", { file: "og-default" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: number;
      failed: number;
      total: number;
      results: { file: string; blobUrl: string | null }[];
    };
    expect(body.success).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.total).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.file).toBe("og-default");
    expect(body.results[0]!.blobUrl).toBe("https://blob.test/og/og-default.png");

    expect(imageGen.calls).toHaveLength(1);
    const genCall = imageGen.calls[0]!;
    expect(genCall.blobPath).toBe("og/og-default.png");
    expect(genCall.model).toBe("grok-imagine-image-pro");
    expect(genCall.aspectRatio).toBe("16:9");
    expect(genCall.prompt).toContain("AIG!itch");
  });

  it("captures error and still returns 200 with success=0 when helper throws", async () => {
    mockIsAdmin = true;
    imageGen.queue.push(new Error("xAI upstream down"));
    const res = await call("POST", { file: "og-default" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: number;
      failed: number;
      results: { blobUrl: string | null; error?: string }[];
    };
    expect(body.success).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.blobUrl).toBeNull();
    expect(body.results[0]!.error).toContain("xAI upstream down");
  });
});

describe("POST /api/admin/generate-og-images — batch path", () => {
  it("generates all 21 images when no file is specified", async () => {
    mockIsAdmin = true;
    const res = await call("POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: number;
      failed: number;
      total: number;
      results: { file: string; blobUrl: string | null }[];
      message: string;
    };
    expect(body.total).toBe(21);
    expect(body.success).toBe(21);
    expect(body.failed).toBe(0);
    expect(body.message).toContain("Generated 21/21");
    expect(imageGen.calls).toHaveLength(21);

    // All blobPaths should follow the `og/{file}.png` convention.
    for (const c of imageGen.calls) {
      expect(c.blobPath).toMatch(/^og\/og-[a-z-]+\.png$/);
      expect(c.model).toBe("grok-imagine-image-pro");
      expect(c.aspectRatio).toBe("16:9");
    }

    // Spot-check both ends of the list.
    const files = body.results.map((r) => r.file);
    expect(files[0]).toBe("og-default");
    expect(files[files.length - 1]).toBe("og-marketplace-qvc");
  });

  it("isolates errors — some succeed, some fail in the same batch", async () => {
    mockIsAdmin = true;
    // First call fails; the other 20 use the default-happy fallback.
    imageGen.queue.push(new Error("first one boom"));
    const res = await call("POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: number;
      failed: number;
      message: string;
      results: { blobUrl: string | null; error?: string }[];
    };
    expect(body.success).toBe(20);
    expect(body.failed).toBe(1);
    expect(body.message).toContain("1 failed");
    expect(body.results[0]!.blobUrl).toBeNull();
    expect(body.results[0]!.error).toContain("first one boom");
    expect(body.results[1]!.blobUrl).not.toBeNull();
  });
});
