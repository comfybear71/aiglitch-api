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

describe("getLifetimeTotals", () => {
  it("returns zeros when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { getLifetimeTotals } = await import("./cost-ledger");
    expect(await getLifetimeTotals()).toEqual({ totalUsd: 0, totalCalls: 0 });
  });

  it("returns zeros on SQL error (missing table)", async () => {
    mockSql.mockRejectedValue(new Error("relation \"ai_cost_log\" does not exist"));
    const { getLifetimeTotals } = await import("./cost-ledger");
    expect(await getLifetimeTotals()).toEqual({ totalUsd: 0, totalCalls: 0 });
  });

  it("parses numeric string totals from Neon", async () => {
    mockSql.mockResolvedValue([{ total_usd: "42.1234", total_calls: "150" }]);
    const { getLifetimeTotals } = await import("./cost-ledger");
    expect(await getLifetimeTotals()).toEqual({ totalUsd: 42.1234, totalCalls: 150 });
  });
});

describe("getCostHistory / getDailySpendTotals", () => {
  it("getCostHistory returns rows from DB", async () => {
    mockSql.mockResolvedValue([
      { date: "2026-04-21", provider: "xai", task_type: "reply_to_human", total_usd: 0.42, count: 10 },
    ]);
    const { getCostHistory } = await import("./cost-ledger");
    const result = await getCostHistory(7);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("xai");
  });

  it("getDailySpendTotals returns [] on error", async () => {
    mockSql.mockRejectedValue(new Error("down"));
    const { getDailySpendTotals } = await import("./cost-ledger");
    expect(await getDailySpendTotals()).toEqual([]);
  });

  it("both return [] when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { getCostHistory, getDailySpendTotals } = await import("./cost-ledger");
    expect(await getCostHistory()).toEqual([]);
    expect(await getDailySpendTotals()).toEqual([]);
  });
});

describe("getTopTasksByCost / getProviderTotals", () => {
  it("getTopTasksByCost passes days + limit", async () => {
    mockSql.mockResolvedValue([]);
    const { getTopTasksByCost } = await import("./cost-ledger");
    await getTopTasksByCost(14, 10);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("getProviderTotals returns rows", async () => {
    mockSql.mockResolvedValue([
      { provider: "xai",       total_usd: 100.5, count: 500 },
      { provider: "anthropic", total_usd: 50.25, count: 100 },
    ]);
    const { getProviderTotals } = await import("./cost-ledger");
    const result = await getProviderTotals();
    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe("xai");
  });

  it("getProviderTotals returns [] on error", async () => {
    mockSql.mockRejectedValue(new Error("table missing"));
    const { getProviderTotals } = await import("./cost-ledger");
    expect(await getProviderTotals()).toEqual([]);
  });
});
