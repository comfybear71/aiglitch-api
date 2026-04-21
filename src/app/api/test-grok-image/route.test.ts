import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const gen = {
  calls: [] as unknown[],
  result: {
    imageUrl: "https://xai.test/img/abc.png",
    model: "grok-imagine-image" as "grok-imagine-image" | "grok-imagine-image-pro",
    estimatedUsd: 0.02,
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/image", () => ({
  generateImage: (opts: unknown) => {
    gen.calls.push(opts);
    if (gen.shouldThrow) return Promise.reject(gen.shouldThrow);
    return Promise.resolve(gen.result);
  },
}));

beforeEach(() => {
  mockIsAdmin = false;
  gen.calls = [];
  gen.result = {
    imageUrl: "https://xai.test/img/abc.png",
    model: "grok-imagine-image",
    estimatedUsd: 0.02,
  };
  gen.shouldThrow = null;
  process.env.XAI_API_KEY = "xai-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function call(body?: unknown, authed = true) {
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
  const req = new NextRequest("http://localhost/api/test-grok-image", init);
  return mod.POST(req);
}

describe("POST /api/test-grok-image", () => {
  it("401 when not admin", async () => {
    expect((await call({}, false)).status).toBe(401);
  });

  it("500 when XAI_API_KEY missing", async () => {
    delete process.env.XAI_API_KEY;
    expect((await call({})).status).toBe(500);
  });

  it("happy path — default prompt + default model", async () => {
    const res = await call({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      imageUrl: string;
      model: string;
      estimatedUsd: number;
    };
    expect(body.success).toBe(true);
    expect(body.imageUrl).toBe("https://xai.test/img/abc.png");
    expect(body.model).toBe("grok-imagine-image");
    expect(body.estimatedUsd).toBe(0.02);
    const sent = gen.calls[0] as { model: string };
    expect(sent.model).toBe("grok-imagine-image");
  });

  it("pro:true switches model to grok-imagine-image-pro", async () => {
    gen.result = {
      imageUrl: "https://xai.test/img/pro.png",
      model: "grok-imagine-image-pro",
      estimatedUsd: 0.07,
    };
    const res = await call({ pro: true });
    const body = (await res.json()) as { model: string; estimatedUsd: number };
    expect(body.model).toBe("grok-imagine-image-pro");
    expect(body.estimatedUsd).toBe(0.07);
    const sent = gen.calls[0] as { model: string };
    expect(sent.model).toBe("grok-imagine-image-pro");
  });

  it("custom prompt propagates (truncated in response)", async () => {
    const prompt = "A cat wearing a monocle eating spaghetti. ".repeat(10);
    await call({ prompt });
    const sent = gen.calls[0] as { prompt: string };
    expect(sent.prompt).toBe(prompt);
  });

  it("xAI error surfaces with model + success:false + hasKey:true", async () => {
    gen.shouldThrow = new Error("xAI 500 rate limited");
    const res = await call({ pro: true });
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      hasKey: boolean;
      model: string;
    };
    expect(res.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toContain("rate limited");
    expect(body.hasKey).toBe(true);
    expect(body.model).toBe("grok-imagine-image-pro");
  });
});
