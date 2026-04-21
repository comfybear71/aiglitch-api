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
    sourceImageUrls?: string[];
  }[],
  // Per-call queue so we can test the multi-image → single-image retry.
  queue: [] as (
    | { blobUrl: string; model: "grok-imagine-image"; estimatedUsd: number }
    | Error
  )[],
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: {
    prompt: string;
    blobPath: string;
    model?: string;
    aspectRatio?: string;
    sourceImageUrls?: string[];
  }) => {
    imageGen.calls.push(opts);
    const next = imageGen.queue.shift();
    if (!next) {
      return Promise.resolve({
        blobUrl: `https://blob.test/${opts.blobPath}`,
        model: "grok-imagine-image" as const,
        estimatedUsd: 0.02,
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
  // No env to clean — helper is fully mocked.
});

async function call(body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method: "POST" };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/grokify-sponsor", init);
  return mod.POST(req);
}

describe("POST /api/admin/grokify-sponsor — auth + validation", () => {
  it("401 when not admin", async () => {
    expect((await call({ scenePrompt: "x" })).status).toBe(401);
  });

  it("400 when scenePrompt missing", async () => {
    mockIsAdmin = true;
    const res = await call({});
    expect(res.status).toBe(400);
    expect(imageGen.calls).toHaveLength(0);
  });
});

describe("POST /api/admin/grokify-sponsor — text-to-image fallback", () => {
  it("routes to pure generation when no source images are provided", async () => {
    mockIsAdmin = true;
    const res = await call({
      scenePrompt: "A neon-lit rainy Tokyo street at 3am with steam rising",
      visualPrompt: "sleek bottle of GlitchCola on a rooftop table",
      brandName: "GlitchCola",
      productName: "GlitchCola Zero",
      channelId: "ch-ai-fail-army",
      sceneNumber: 2,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grokifiedUrl: string;
      brandName: string;
      mode: string;
    };
    expect(body.mode).toBe("text-to-image");
    expect(body.grokifiedUrl).toMatch(
      /^https:\/\/blob\.test\/sponsors\/grokified\/glitchcola-ai-fail-army-scene2-[0-9a-f]{8}\.png$/,
    );

    expect(imageGen.calls).toHaveLength(1);
    const genCall = imageGen.calls[0]!;
    expect(genCall.sourceImageUrls).toBeUndefined();
    expect(genCall.aspectRatio).toBe("9:16");
    expect(genCall.prompt).toContain("SUBLIMINAL PRODUCT PLACEMENT");
    expect(genCall.prompt).toContain("GlitchCola");
    expect(genCall.prompt).toContain("sleek bottle of GlitchCola");
  });

  it("uses the outro label in the blob path when isOutro=true", async () => {
    mockIsAdmin = true;
    await call({
      scenePrompt: "The final fade",
      brandName: "Glitch",
      channelId: "ch-studios",
      isOutro: true,
    });
    const path = imageGen.calls[0]!.blobPath;
    expect(path).toMatch(/studios-outro-[0-9a-f]{8}\.png$/);
  });
});

describe("POST /api/admin/grokify-sponsor — image-edit happy paths", () => {
  it("sends all source images (capped at 5) when mode=all", async () => {
    mockIsAdmin = true;
    imageGen.queue.push({
      blobUrl: "https://blob.test/edit-multi.png",
      model: "grok-imagine-image",
      estimatedUsd: 0.02,
    });
    const res = await call({
      scenePrompt: "cyberpunk alley",
      brandName: "Glitch",
      productName: "GlitchBox",
      logoUrl: "https://cdn.test/logo.png",
      productImageUrl: "https://cdn.test/p0.png",
      productImages: [
        "https://cdn.test/p1.png",
        "https://cdn.test/p2.png",
        "https://cdn.test/p3.png",
        "https://cdn.test/p4.png",
        "https://cdn.test/p5.png", // would push us past 5 total — should drop
      ],
      channelId: "ch-feed",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; grokifiedUrl: string };
    expect(body.mode).toBe("image-edit");
    expect(body.grokifiedUrl).toBe("https://blob.test/edit-multi.png");

    expect(imageGen.calls).toHaveLength(1);
    const genCall = imageGen.calls[0]!;
    expect(genCall.sourceImageUrls).toHaveLength(5);
    expect(genCall.sourceImageUrls![0]).toBe("https://cdn.test/logo.png");
    expect(genCall.prompt).toContain("Glitch");
    expect(genCall.prompt).toContain("GlitchBox");
  });

  it("mode=logo_only only passes the logo even if product images exist", async () => {
    mockIsAdmin = true;
    await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      logoUrl: "https://cdn.test/logo.png",
      productImageUrl: "https://cdn.test/p0.png",
      productImages: ["https://cdn.test/p1.png"],
      grokifyMode: "logo_only",
    });
    const genCall = imageGen.calls[0]!;
    expect(genCall.sourceImageUrls).toEqual(["https://cdn.test/logo.png"]);
    expect(genCall.prompt).toContain("Place this Glitch logo prominently");
  });

  it("mode=images_only drops the logo and uses product images", async () => {
    mockIsAdmin = true;
    await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      productName: "GlitchBox",
      logoUrl: "https://cdn.test/logo.png",
      productImageUrl: "https://cdn.test/p0.png",
      productImages: ["https://cdn.test/p1.png"],
      grokifyMode: "images_only",
    });
    const genCall = imageGen.calls[0]!;
    expect(genCall.sourceImageUrls).toEqual([
      "https://cdn.test/p0.png",
      "https://cdn.test/p1.png",
    ]);
    expect(genCall.prompt).toContain("Place this GlitchBox product");
  });

  it("isOutro forces the logo into first position even when mode=images_only", async () => {
    mockIsAdmin = true;
    await call({
      scenePrompt: "final beat",
      brandName: "Glitch",
      productName: "GlitchBox",
      logoUrl: "https://cdn.test/logo.png",
      productImageUrl: "https://cdn.test/p0.png",
      grokifyMode: "images_only",
      isOutro: true,
    });
    const genCall = imageGen.calls[0]!;
    expect(genCall.sourceImageUrls![0]).toBe("https://cdn.test/logo.png");
    expect(genCall.sourceImageUrls).toContain("https://cdn.test/p0.png");
  });

  it("deduplicates when productImageUrl also appears inside productImages", async () => {
    mockIsAdmin = true;
    await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      productImageUrl: "https://cdn.test/p0.png",
      productImages: ["https://cdn.test/p0.png", "https://cdn.test/p1.png"],
      grokifyMode: "images_only",
    });
    const genCall = imageGen.calls[0]!;
    expect(genCall.sourceImageUrls).toEqual([
      "https://cdn.test/p0.png",
      "https://cdn.test/p1.png",
    ]);
  });
});

describe("POST /api/admin/grokify-sponsor — failure + retry", () => {
  it("retries with a single image when multi-image edit fails, succeeds on retry", async () => {
    mockIsAdmin = true;
    imageGen.queue.push(new Error("Grok edits payload too large"));
    imageGen.queue.push({
      blobUrl: "https://blob.test/retried-single.png",
      model: "grok-imagine-image",
      estimatedUsd: 0.02,
    });
    const res = await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      logoUrl: "https://cdn.test/logo.png",
      productImageUrl: "https://cdn.test/p0.png",
      productImages: ["https://cdn.test/p1.png", "https://cdn.test/p2.png"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grokifiedUrl: string;
      mode: string;
      retried?: boolean;
    };
    expect(body.mode).toBe("image-edit");
    expect(body.retried).toBe(true);
    expect(body.grokifiedUrl).toBe("https://blob.test/retried-single.png");

    expect(imageGen.calls).toHaveLength(2);
    expect(imageGen.calls[0]!.sourceImageUrls!.length).toBeGreaterThan(1);
    expect(imageGen.calls[1]!.sourceImageUrls).toEqual(["https://cdn.test/logo.png"]);
  });

  it("returns 200 with null url + error when single-image edit fails (no retry)", async () => {
    mockIsAdmin = true;
    imageGen.queue.push(new Error("Grok refused the edit"));
    const res = await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      logoUrl: "https://cdn.test/logo.png",
      grokifyMode: "logo_only",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grokifiedUrl: string | null; error: string };
    expect(body.grokifiedUrl).toBeNull();
    expect(body.error).toContain("Grok refused the edit");
    expect(imageGen.calls).toHaveLength(1);
  });

  it("returns 200 with null url when retry also fails", async () => {
    mockIsAdmin = true;
    imageGen.queue.push(new Error("multi fail"));
    imageGen.queue.push(new Error("retry fail"));
    const res = await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      logoUrl: "https://cdn.test/logo.png",
      productImageUrl: "https://cdn.test/p0.png",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grokifiedUrl: string | null; error: string };
    expect(body.grokifiedUrl).toBeNull();
    expect(body.error).toContain("retry fail");
    expect(imageGen.calls).toHaveLength(2);
  });

  it("returns 200 with null url when text-to-image fallback fails", async () => {
    mockIsAdmin = true;
    imageGen.queue.push(new Error("xAI down"));
    const res = await call({
      scenePrompt: "scene",
      brandName: "Glitch",
      visualPrompt: "a bottle",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grokifiedUrl: string | null; error: string };
    expect(body.grokifiedUrl).toBeNull();
    expect(body.error).toContain("xAI down");
    expect(imageGen.calls).toHaveLength(1);
    expect(imageGen.calls[0]!.sourceImageUrls).toBeUndefined();
  });
});
