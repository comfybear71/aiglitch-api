import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const canProceedMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
vi.mock("@/lib/ai/circuit-breaker", () => ({
  canProceed: (...args: unknown[]) => canProceedMock(...args),
  recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
  recordFailure: (...args: unknown[]) => recordFailureMock(...args),
}));

const logAiCostMock = vi.fn();
vi.mock("@/lib/ai/cost-ledger", () => ({
  logAiCost: (...args: unknown[]) => logAiCostMock(...args),
}));

beforeEach(() => {
  canProceedMock.mockReset();
  recordSuccessMock.mockReset();
  recordFailureMock.mockReset();
  logAiCostMock.mockReset();
  canProceedMock.mockResolvedValue(true);
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetch(
  responses: { ok: boolean; status?: number; body: unknown }[],
) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift() ?? { ok: true, body: {} };
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  });
}

describe("isXAIConfigured", () => {
  it("returns true when XAI_API_KEY is set", async () => {
    process.env.XAI_API_KEY = "xai-key";
    const { isXAIConfigured } = await import("./xai-extras");
    expect(isXAIConfigured()).toBe(true);
  });

  it("returns false when XAI_API_KEY is unset", async () => {
    delete process.env.XAI_API_KEY;
    const { isXAIConfigured } = await import("./xai-extras");
    expect(isXAIConfigured()).toBe(false);
  });
});

describe("generateWithGrok", () => {
  it("returns null when XAI_API_KEY is not set", async () => {
    delete process.env.XAI_API_KEY;
    const { generateWithGrok } = await import("./xai-extras");
    const result = await generateWithGrok("sys", "user");
    expect(result).toBeNull();
    expect(canProceedMock).not.toHaveBeenCalled();
  });

  it("returns null when circuit breaker is open", async () => {
    process.env.XAI_API_KEY = "x";
    canProceedMock.mockResolvedValue(false);
    const { generateWithGrok } = await import("./xai-extras");
    const result = await generateWithGrok("sys", "user");
    expect(result).toBeNull();
  });

  it("returns text + logs cost on a successful response", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          ok: true,
          body: {
            choices: [{ message: { content: "grok says hi" } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          },
        },
      ]),
    );
    const { generateWithGrok } = await import("./xai-extras");
    const text = await generateWithGrok("sys", "user");
    expect(text).toBe("grok says hi");
    expect(recordSuccessMock).toHaveBeenCalledWith("xai");
    expect(logAiCostMock).toHaveBeenCalledOnce();
    const call = logAiCostMock.mock.calls[0][0] as {
      provider: string;
      inputTokens: number;
      outputTokens: number;
    };
    expect(call.provider).toBe("xai");
    expect(call.inputTokens).toBe(100);
    expect(call.outputTokens).toBe(50);
  });

  it("falls back to legacy model after primary model fails non-transiently", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([
        { ok: false, status: 400, body: { error: "bad request" } },
        {
          ok: true,
          body: {
            choices: [{ message: { content: "legacy says hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        },
      ]),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { generateWithGrok } = await import("./xai-extras");
    const text = await generateWithGrok("sys", "user", 100, "nonReasoning");
    expect(text).toBe("legacy says hi");
    expect(recordFailureMock).toHaveBeenCalledWith("xai");
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns null after exhausting retries on legacy model", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: false, status: 400, body: { error: "bad" } }]),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { generateWithGrok } = await import("./xai-extras");
    const result = await generateWithGrok("sys", "user", 100, "legacy");
    expect(result).toBeNull();
    errSpy.mockRestore();
  });
});

describe("submitVideoJob", () => {
  it("returns error when XAI_API_KEY is missing", async () => {
    delete process.env.XAI_API_KEY;
    const { submitVideoJob } = await import("./xai-extras");
    const result = await submitVideoJob("a cat in space");
    expect(result.provider).toBe("none");
    expect(result.error).toContain("XAI_API_KEY");
  });

  it("returns request_id when xAI accepts the job async", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: true, body: { request_id: "req-123" } }]),
    );
    const { submitVideoJob } = await import("./xai-extras");
    const result = await submitVideoJob("a cat in space", 10, "16:9");
    expect(result.provider).toBe("grok");
    expect(result.requestId).toBe("req-123");
    expect(result.videoUrl).toBeNull();
  });

  it("returns synchronous video URL + logs cost when xAI returns one immediately", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([
        { ok: true, body: { video: { url: "https://cdn/video.mp4" } } },
      ]),
    );
    const { submitVideoJob } = await import("./xai-extras");
    const result = await submitVideoJob("a cat in space", 10);
    expect(result.videoUrl).toBe("https://cdn/video.mp4");
    expect(result.provider).toBe("grok");
    expect(logAiCostMock).toHaveBeenCalledOnce();
  });

  it("returns provider:none with error body on HTTP failure (Kie fallback deferred)", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: false, status: 401, body: { error: "unauthorized" } }]),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { submitVideoJob } = await import("./xai-extras");
    const result = await submitVideoJob("a cat");
    expect(result.provider).toBe("none");
    expect(result.fellBack).toBe(false);
    expect(result.error).toContain("grok_http_401");
    errSpy.mockRestore();
  });

  it("includes image_url in body when provided", async () => {
    process.env.XAI_API_KEY = "x";
    const fetchMock = mockFetch([{ ok: true, body: { request_id: "req-x" } }]);
    vi.stubGlobal("fetch", fetchMock);
    const { submitVideoJob } = await import("./xai-extras");
    await submitVideoJob("scene", 10, "16:9", "https://cdn/ref.png");
    const init = fetchMock.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as { image_url?: string };
    expect(body.image_url).toBe("https://cdn/ref.png");
  });
});

describe("pollVideoJob", () => {
  it("returns failed when XAI_API_KEY is missing", async () => {
    delete process.env.XAI_API_KEY;
    const { pollVideoJob } = await import("./xai-extras");
    const result = await pollVideoJob("req-1");
    expect(result.status).toBe("failed");
  });

  it("returns done + URL when xAI says status:done", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          ok: true,
          body: { status: "done", video: { url: "https://cdn/x.mp4" } },
        },
      ]),
    );
    const { pollVideoJob } = await import("./xai-extras");
    const result = await pollVideoJob("req-1");
    expect(result.status).toBe("done");
    expect(result.videoUrl).toBe("https://cdn/x.mp4");
  });

  it("returns pending when status is anything else", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: true, body: { status: "processing" } }]),
    );
    const { pollVideoJob } = await import("./xai-extras");
    const result = await pollVideoJob("req-1");
    expect(result.status).toBe("pending");
  });

  it("returns failed when xAI says status:failed", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: true, body: { status: "failed" } }]),
    );
    const { pollVideoJob } = await import("./xai-extras");
    const result = await pollVideoJob("req-1");
    expect(result.status).toBe("failed");
  });
});

describe("extendVideoFromFrame", () => {
  it("returns error when XAI_API_KEY is missing", async () => {
    delete process.env.XAI_API_KEY;
    const { extendVideoFromFrame } = await import("./xai-extras");
    const result = await extendVideoFromFrame(
      "https://cdn/frame.png",
      "scene continues",
    );
    expect(result.error).toContain("XAI_API_KEY");
    expect(result.requestId).toBeNull();
    expect(result.videoUrl).toBeNull();
  });

  it("returns requestId when xAI accepts async", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: true, body: { request_id: "ext-456" } }]),
    );
    const { extendVideoFromFrame } = await import("./xai-extras");
    const result = await extendVideoFromFrame(
      "https://cdn/frame.png",
      "scene continues",
      10,
      "9:16",
    );
    expect(result.requestId).toBe("ext-456");
    expect(result.videoUrl).toBeNull();
    expect(result.error).toBeNull();
  });

  it("returns videoUrl + logs cost when xAI returns immediately", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([
        { ok: true, body: { video: { url: "https://cdn/ext.mp4" } } },
      ]),
    );
    const { extendVideoFromFrame } = await import("./xai-extras");
    const result = await extendVideoFromFrame(
      "https://cdn/frame.png",
      "scene continues",
    );
    expect(result.videoUrl).toBe("https://cdn/ext.mp4");
    expect(result.requestId).toBeNull();
    expect(result.error).toBeNull();
    expect(logAiCostMock).toHaveBeenCalledOnce();
  });

  it("returns error on HTTP failure", async () => {
    process.env.XAI_API_KEY = "x";
    vi.stubGlobal(
      "fetch",
      mockFetch([{ ok: false, status: 500, body: { error: "server error" } }]),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { extendVideoFromFrame } = await import("./xai-extras");
    const result = await extendVideoFromFrame(
      "https://cdn/frame.png",
      "scene",
    );
    expect(result.error).toContain("HTTP 500");
    expect(result.requestId).toBeNull();
    expect(result.videoUrl).toBeNull();
    errSpy.mockRestore();
  });

  it("includes image_url in the request body", async () => {
    process.env.XAI_API_KEY = "x";
    const fetchMock = mockFetch([
      { ok: true, body: { request_id: "ext-789" } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const { extendVideoFromFrame } = await import("./xai-extras");
    await extendVideoFromFrame("https://cdn/frame.png", "scene", 10, "9:16");
    const init = fetchMock.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as { image_url?: string };
    expect(body.image_url).toBe("https://cdn/frame.png");
  });
});
