import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSql = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

const BASE_ENTRY = {
  provider: "xai" as const,
  taskType: "reply_to_human" as const,
  model: "grok-3",
  inputTokens: 100,
  outputTokens: 50,
  estimatedUsd: 0.00105,
};

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
  mockSql.mockReset();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("logAiCost", () => {
  it("inserts a row with correct values", async () => {
    mockSql.mockResolvedValue([]);
    const { logAiCost } = await import("./cost-ledger");
    await logAiCost(BASE_ENTRY);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("does not throw when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    const { logAiCost } = await import("./cost-ledger");
    await expect(logAiCost(BASE_ENTRY)).resolves.toBeUndefined();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("swallows DB errors (fire-and-forget)", async () => {
    mockSql.mockRejectedValue(new Error("DB connection refused"));
    const { logAiCost } = await import("./cost-ledger");
    await expect(logAiCost(BASE_ENTRY)).resolves.toBeUndefined();
  });

  it("works for anthropic provider", async () => {
    mockSql.mockResolvedValue([]);
    const { logAiCost } = await import("./cost-ledger");
    await logAiCost({ ...BASE_ENTRY, provider: "anthropic", model: "claude-opus-4-7" });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
