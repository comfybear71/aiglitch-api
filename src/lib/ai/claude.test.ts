import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  vi.resetModules();
  mockCreate.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function makeResp(
  text: string,
  inputTokens = 10,
  outputTokens = 20,
  model = "claude-opus-4-7",
) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    model,
  };
}

describe("claudeComplete", () => {
  it("returns text + token counts + estimated cost", async () => {
    mockCreate.mockResolvedValue(makeResp("Hello!", 100, 50));
    const { claudeComplete } = await import("./claude");
    const result = await claudeComplete({ userPrompt: "Hi" });
    expect(result.text).toBe("Hello!");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    // (100 * 15 + 50 * 75) / 1_000_000 = (1500 + 3750) / 1e6
    expect(result.estimatedUsd).toBeCloseTo(0.00525, 6);
  });

  it("uses CLAUDE_MODEL by default", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { claudeComplete, CLAUDE_MODEL } = await import("./claude");
    const result = await claudeComplete({ userPrompt: "test" });
    expect(result.model).toBe(CLAUDE_MODEL);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: CLAUDE_MODEL }),
    );
  });

  it("passes system prompt when provided", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { claudeComplete } = await import("./claude");
    await claudeComplete({ systemPrompt: "Be helpful", userPrompt: "test" });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: "Be helpful" }),
    );
  });

  it("omits system when not provided", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { claudeComplete } = await import("./claude");
    await claudeComplete({ userPrompt: "test" });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: undefined }),
    );
  });

  it("respects custom model and maxTokens", async () => {
    mockCreate.mockResolvedValue(makeResp("ok"));
    const { claudeComplete } = await import("./claude");
    await claudeComplete({ userPrompt: "test", model: "claude-sonnet-4-6", maxTokens: 128 });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6", max_tokens: 128 }),
    );
  });

  it("concatenates multiple text blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
      model: "claude-opus-4-7",
    });
    const { claudeComplete } = await import("./claude");
    const result = await claudeComplete({ userPrompt: "test" });
    expect(result.text).toBe("Hello world");
  });

  it("ignores non-text content blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "tool_use", id: "x", name: "fn", input: {} },
        { type: "text", text: "final" },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
      model: "claude-opus-4-7",
    });
    const { claudeComplete } = await import("./claude");
    const result = await claudeComplete({ userPrompt: "test" });
    expect(result.text).toBe("final");
  });

  it("throws when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { claudeComplete, __resetClaudeClient } = await import("./claude");
    __resetClaudeClient();
    await expect(claudeComplete({ userPrompt: "test" })).rejects.toThrow(
      "ANTHROPIC_API_KEY not set",
    );
  });
});
