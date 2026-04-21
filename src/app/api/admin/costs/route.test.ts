import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const getLifetimeTotalsMock = vi.fn();
const getCostHistoryMock = vi.fn();
const getTopTasksMock = vi.fn();
const getProviderTotalsMock = vi.fn();
const getDailySpendTotalsMock = vi.fn();

vi.mock("@/lib/ai/cost-ledger", () => ({
  getLifetimeTotals:  () => getLifetimeTotalsMock(),
  getCostHistory:     (...a: unknown[]) => getCostHistoryMock(...a),
  getTopTasksByCost:  (...a: unknown[]) => getTopTasksMock(...a),
  getProviderTotals:  () => getProviderTotalsMock(),
  getDailySpendTotals: (...a: unknown[]) => getDailySpendTotalsMock(...a),
}));

beforeEach(() => {
  mockIsAdmin = false;
  getLifetimeTotalsMock.mockReset();
  getCostHistoryMock.mockReset();
  getTopTasksMock.mockReset();
  getProviderTotalsMock.mockReset();
  getDailySpendTotalsMock.mockReset();
  // defaults
  getLifetimeTotalsMock.mockResolvedValue({ totalUsd: 0, totalCalls: 0 });
  getCostHistoryMock.mockResolvedValue([]);
  getTopTasksMock.mockResolvedValue([]);
  getProviderTotalsMock.mockResolvedValue([]);
  getDailySpendTotalsMock.mockResolvedValue([]);
  vi.resetModules();
});

afterEach(() => {
  delete process.env.VERCEL_TOKEN;
  delete process.env.ANTHROPIC_MONTHLY_BUDGET;
  delete process.env.XAI_MONTHLY_BUDGET;
  vi.restoreAllMocks();
});

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/admin/costs${query}`));
}

describe("GET /api/admin/costs", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns empty dashboard when no cost data exists", async () => {
    mockIsAdmin = true;
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lifetime: { total_usd: number; total_calls: number };
      history: unknown[];
      daily_totals: unknown[];
      vercel: { available: boolean };
      days: number;
    };
    expect(body.lifetime).toEqual({ total_usd: 0, total_calls: 0 });
    expect(body.history).toEqual([]);
    expect(body.vercel.available).toBe(false); // no VERCEL_TOKEN
    expect(body.days).toBe(7);
  });

  it("clamps ?days= to MAX_DAYS (90)", async () => {
    mockIsAdmin = true;
    const res = await callGET("?days=9999");
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(90);
    expect(getCostHistoryMock).toHaveBeenCalledWith(90);
  });

  it("passes a sane ?days= through to the lib calls", async () => {
    mockIsAdmin = true;
    await callGET("?days=30");
    expect(getCostHistoryMock).toHaveBeenCalledWith(30);
    expect(getDailySpendTotalsMock).toHaveBeenCalledWith(30);
    expect(getTopTasksMock).toHaveBeenCalledWith(30, 5);
  });

  it("computes credit balances from env budgets + provider totals", async () => {
    mockIsAdmin = true;
    process.env.ANTHROPIC_MONTHLY_BUDGET = "100";
    process.env.XAI_MONTHLY_BUDGET = "50";
    getProviderTotalsMock.mockResolvedValue([
      { provider: "anthropic", total_usd: 25,   count: 100 },
      { provider: "xai",       total_usd: 10.5, count: 400 },
    ]);

    const res = await callGET();
    const body = (await res.json()) as {
      credit_balances: {
        anthropic: { budget: number; spent: number; remaining: number };
        xai:       { budget: number; spent: number; remaining: number };
      };
    };
    expect(body.credit_balances.anthropic).toEqual({ budget: 100, spent: 25, remaining: 75 });
    expect(body.credit_balances.xai).toEqual({ budget: 50, spent: 10.5, remaining: 39.5 });
  });

  it("credit balances remaining is null when budget env var not set", async () => {
    mockIsAdmin = true;
    getProviderTotalsMock.mockResolvedValue([
      { provider: "xai", total_usd: 10, count: 1 },
    ]);
    const res = await callGET();
    const body = (await res.json()) as {
      credit_balances: { xai: { remaining: number | null } };
    };
    expect(body.credit_balances.xai.remaining).toBeNull();
  });

  it("vercel.available:false when VERCEL_TOKEN unset (no outbound call)", async () => {
    mockIsAdmin = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await callGET();
    const body = (await res.json()) as { vercel: { available: boolean } };
    expect(body.vercel.available).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
