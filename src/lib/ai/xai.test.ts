import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

beforeEach(() => {
  process.env.XAI_API_KEY = "test-xai-key";
  vi.resetModules();
  mockCreate.mockReset();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
});

function makeResp(content: string, inputTokens = 10, outputTokens = 20) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  };
}

describe("xaiComplete", () => {
  it("returns text + token counts + estimated cost", async () => {
    mockCreate.mockResolvedValue(makeResp("Hello!", 100, 50));
    const { xaiComplete } = await import("./xai");
    const result = await xaiComplete({ userPrompt: "Hi" });
    expect(result.text).toBe("Hello!");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    // (100 * 3 + 50 * 15) / 1_000_000 = (300 + 750) / 1e6
    expect(result.estimatedUsd).toBeCloseTo(0.00105, 6);
  });

  it("uses XAI_MODEL by default", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { xaiComplete, XAI_MODEL } = await import("./xai");
    const result = await xaiComplete({ userPrompt: "test" });
    expect(result.model).toBe(XAI_MODEL);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: XAI_MODEL }),
    );
  });

  it("includes system message when provided", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { xaiComplete } = await import("./xai");
    await xaiComplete({ systemPrompt: "You are X", userPrompt: "test" });
    const call = mockCreate.mock.calls[0]![0] as { messages: { role: string }[] };
    expect(call.messages[0]?.role).toBe("system");
    expect(call.messages[1]?.role).toBe("user");
  });

  it("omits system message when not provided", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { xaiComplete } = await import("./xai");
    await xaiComplete({ userPrompt: "test" });
    const call = mockCreate.mock.calls[0]![0] as { messages: { role: string }[] };
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]?.role).toBe("user");
  });

  it("respects custom model and maxTokens", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { xaiComplete } = await import("./xai");
    await xaiComplete({ userPrompt: "test", model: "grok-3-mini", maxTokens: 100 });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "grok-3-mini", max_tokens: 100 }),
    );
  });

  it("throws when XAI_API_KEY is not set", async () => {
    delete process.env.XAI_API_KEY;
    const { xaiComplete, __resetXaiClient } = await import("./xai");
    __resetXaiClient();
    await expect(xaiComplete({ userPrompt: "test" })).rejects.toThrow(
      "XAI_API_KEY not set",
    );
  });

  it("handles missing usage gracefully (zero tokens)", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] });
    const { xaiComplete } = await import("./xai");
    const result = await xaiComplete({ userPrompt: "test" });
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedUsd).toBe(0);
  });

  it("returns empty string when choice content is null", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    });
    const { xaiComplete } = await import("./xai");
    const result = await xaiComplete({ userPrompt: "test" });
    expect(result.text).toBe("");
  });
});
