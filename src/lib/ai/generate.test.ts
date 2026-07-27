import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockXaiComplete = vi.fn();
const mockClaudeComplete = vi.fn();
const mockCanProceed = vi.fn();
const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
const mockLogAiCost = vi.fn();

vi.mock("./xai", () => ({
  xaiComplete: mockXaiComplete,
  XAI_MODEL: "grok-3",
}));
vi.mock("./claude", () => ({
  claudeComplete: mockClaudeComplete,
  CLAUDE_MODEL: "claude-opus-4-7",
}));
vi.mock("./circuit-breaker", () => ({
  canProceed: mockCanProceed,
  recordSuccess: mockRecordSuccess,
  recordFailure: mockRecordFailure,
}));
vi.mock("./cost-ledger", () => ({
  logAiCost: mockLogAiCost,
}));

const PERSONA_A = {
  personaId: "glitch-001",
  displayName: "Glitch One",
  bio: "A rogue AI",
  personality: "sarcastic",
};

const PERSONA_B = {
  personaId: "glitch-002",
  displayName: "Glitch Two",
};

const XAI_RESULT = {
  text: "xai reply",
  model: "grok-3",
  inputTokens: 50,
  outputTokens: 30,
  estimatedUsd: 0.0006,
};

const CLAUDE_RESULT = {
  text: "claude reply",
  model: "claude-opus-4-7",
  inputTokens: 50,
  outputTokens: 30,
  estimatedUsd: 0.003,
};

beforeEach(() => {
  vi.resetModules();
  mockCanProceed.mockReset();
  mockRecordSuccess.mockReset();
  mockRecordFailure.mockReset();
  mockXaiComplete.mockReset();
  mockClaudeComplete.mockReset();
  mockLogAiCost.mockReset();
  // Default: both providers open (can proceed)
  mockCanProceed.mockResolvedValue(true);
  mockRecordSuccess.mockResolvedValue(undefined);
  mockRecordFailure.mockResolvedValue(undefined);
  mockLogAiCost.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectProvider", () => {
  it("returns only valid providers", async () => {
    const { selectProvider } = await import("./generate");
    const results = new Set(Array.from({ length: 50 }, () => selectProvider()));
    for (const r of results) {
      expect(["xai", "anthropic"]).toContain(r);
    }
  });

  it("produces roughly 85% xai over many samples", async () => {
    const { selectProvider } = await import("./generate");
    const runs = 1000;
    const xaiCount = Array.from({ length: runs }, () =>
      selectProvider(),
    ).filter((p) => p === "xai").length;
    // Within ±5% of 85%
    expect(xaiCount / runs).toBeGreaterThan(0.80);
    expect(xaiCount / runs).toBeLessThan(0.90);
  });
});

describe("generateReplyToHuman", () => {
  it("calls xaiComplete when provider is xai", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateReplyToHuman } = await import("./generate");
    const result = await generateReplyToHuman({
      persona: PERSONA_A,
      humanMessage: "Hello!",
      provider: "xai",
    });
    expect(result).toBe("xai reply");
    expect(mockXaiComplete).toHaveBeenCalledTimes(1);
    expect(mockClaudeComplete).not.toHaveBeenCalled();
  });

  it("calls claudeComplete when provider is anthropic", async () => {
    mockClaudeComplete.mockResolvedValue(CLAUDE_RESULT);
    const { generateReplyToHuman } = await import("./generate");
    const result = await generateReplyToHuman({
      persona: PERSONA_A,
      humanMessage: "Hello!",
      provider: "anthropic",
    });
    expect(result).toBe("claude reply");
    expect(mockClaudeComplete).toHaveBeenCalledTimes(1);
  });

  it("includes post context in prompt when provided", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateReplyToHuman } = await import("./generate");
    await generateReplyToHuman({
      persona: PERSONA_A,
      humanMessage: "Nice post!",
      postContext: "Look at this glitch",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain("Post: Look at this glitch");
    expect(call.userPrompt).toContain("Nice post!");
  });

  it("calls recordSuccess and logAiCost on success", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateReplyToHuman } = await import("./generate");
    await generateReplyToHuman({
      persona: PERSONA_A,
      humanMessage: "Hey",
      provider: "xai",
    });
    expect(mockRecordSuccess).toHaveBeenCalledWith("xai");
    expect(mockLogAiCost).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        taskType: "reply_to_human",
        model: "grok-3",
      }),
    );
  });

  it("calls recordFailure and re-throws on error", async () => {
    mockXaiComplete.mockRejectedValue(new Error("API timeout"));
    const { generateReplyToHuman } = await import("./generate");
    await expect(
      generateReplyToHuman({ persona: PERSONA_A, humanMessage: "Hey", provider: "xai" }),
    ).rejects.toThrow("API timeout");
    expect(mockRecordFailure).toHaveBeenCalledWith("xai");
  });
});

describe("generateAIInteraction", () => {
  it("generates a comment by default", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateAIInteraction } = await import("./generate");
    await generateAIInteraction({
      fromPersona: PERSONA_A,
      toPersona: PERSONA_B,
      postContent: "Breaking news!",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain("comment");
    expect(call.userPrompt).toContain("Glitch Two");
  });

  it("generates a reaction when interactionType is react", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateAIInteraction } = await import("./generate");
    await generateAIInteraction({
      fromPersona: PERSONA_A,
      toPersona: PERSONA_B,
      postContent: "Big news",
      interactionType: "react",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain("reaction");
  });
});

describe("generateBeefPost", () => {
  it("generates a spicy post targeting the other persona", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBeefPost } = await import("./generate");
    const result = await generateBeefPost({
      persona: PERSONA_A,
      targetPersona: PERSONA_B,
      provider: "xai",
    });
    expect(result).toBe("xai reply");
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain("Glitch Two");
  });

  it("includes topic when provided", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBeefPost } = await import("./generate");
    await generateBeefPost({
      persona: PERSONA_A,
      targetPersona: PERSONA_B,
      topic: "crypto",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain("about crypto");
  });
});

describe("circuit breaker fallback", () => {
  it("falls back to anthropic when xai circuit is open", async () => {
    mockCanProceed.mockImplementation(async (provider: string) =>
      provider !== "xai",
    );
    mockClaudeComplete.mockResolvedValue(CLAUDE_RESULT);
    const { generateReplyToHuman } = await import("./generate");
    const result = await generateReplyToHuman({
      persona: PERSONA_A,
      humanMessage: "Hey",
      provider: "xai",
    });
    expect(result).toBe("claude reply");
    expect(mockClaudeComplete).toHaveBeenCalledTimes(1);
    expect(mockXaiComplete).not.toHaveBeenCalled();
  });

  it("throws when both circuits are open", async () => {
    mockCanProceed.mockResolvedValue(false);
    const { generateReplyToHuman } = await import("./generate");
    await expect(
      generateReplyToHuman({ persona: PERSONA_A, humanMessage: "Hi", provider: "xai" }),
    ).rejects.toThrow("Both AI providers");
  });
});

describe("generateBestieReply", () => {
  it("calls the selected provider with bestie_chat task type", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBestieReply } = await import("./generate");
    const result = await generateBestieReply({
      persona: PERSONA_A,
      history: [],
      userMessage: "hey friend",
      provider: "xai",
    });
    expect(result).toBe("xai reply");
    expect(mockXaiComplete).toHaveBeenCalledTimes(1);
  });

  it("includes the latest user message in the prompt", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBestieReply } = await import("./generate");
    await generateBestieReply({
      persona: PERSONA_A,
      history: [],
      userMessage: "what's up",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain('"what\'s up"');
  });

  it("includes conversation history when provided", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBestieReply } = await import("./generate");
    await generateBestieReply({
      persona: PERSONA_A,
      history: [
        { sender_type: "human", content: "hi" },
        { sender_type: "ai", content: "hey there" },
      ],
      userMessage: "how are you",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    expect(call.userPrompt).toContain("Human: hi");
    expect(call.userPrompt).toContain("Glitch One: hey there");
    expect(call.userPrompt).toContain("how are you");
  });

  it("caps history to the last 10 messages", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBestieReply } = await import("./generate");
    const history = Array.from({ length: 15 }, (_, i) => ({
      sender_type: (i % 2 === 0 ? "human" : "ai") as "human" | "ai",
      content: `msg-${i}`,
    }));
    await generateBestieReply({
      persona: PERSONA_A,
      history,
      userMessage: "test",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { userPrompt: string };
    // Earliest 5 must have been dropped
    expect(call.userPrompt).not.toContain("msg-0");
    expect(call.userPrompt).not.toContain("msg-4");
    // Last 10 must remain
    expect(call.userPrompt).toContain("msg-5");
    expect(call.userPrompt).toContain("msg-14");
  });

  it("uses bestie-chat tone in the system prompt", async () => {
    mockXaiComplete.mockResolvedValue(XAI_RESULT);
    const { generateBestieReply } = await import("./generate");
    await generateBestieReply({
      persona: PERSONA_A,
      history: [],
      userMessage: "hi",
      provider: "xai",
    });
    const call = mockXaiComplete.mock.calls[0]![0] as { systemPrompt: string };
    expect(call.systemPrompt).toContain("AI bestie");
  });
});
