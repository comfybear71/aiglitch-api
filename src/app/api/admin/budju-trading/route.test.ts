/**
 * Smoke tests for /api/admin/budju-trading (990 LOC, 16 lib functions).
 *
 * Strategy: pin the AUTH gate + a sample of action-router shapes. The
 * actual on-chain trade execution / distribution / drain logic lives
 * in `@/lib/trading/budju` (v1.33.0 foundation). Each action's
 * underlying lib call is mocked here; devnet smoke is the real
 * verification before/after the strangler flip.
 *
 * Auth note (preserved verbatim from legacy): `action=process_distribution`
 * accepts EITHER a valid CRON_SECRET via x-vercel-cron-secret /
 * Authorization Bearer OR an admin cookie. Every other action is
 * admin-only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));
// Mock the env bible — its Zod schema parses process.env at import time
// and throws if required fields are missing. We only need JUPITER_API_KEY
// to be readable for the dashboard action; everything else is unused here.
vi.mock("@/lib/bible/env", () => ({
  env: { JUPITER_API_KEY: "test-jupiter-key" },
}));
vi.mock("@/lib/trading/budju", () => ({
  getBudjuDashboard: vi.fn(),
  getBudjuConfig: vi.fn(),
  setBudjuConfig: vi.fn(),
  generatePersonaWallets: vi.fn(),
  deactivatePersonaWallet: vi.fn(),
  activatePersonaWallet: vi.fn(),
  deletePersonaWallet: vi.fn(),
  syncWalletBalances: vi.fn(),
  executeBudjuTradeBatch: vi.fn(),
  distributeFundsFromDistributors: vi.fn(),
  drainWallets: vi.fn(),
  exportWalletKeys: vi.fn(),
  clearFailedTrades: vi.fn(),
  createDistributionJob: vi.fn(),
  processDistributionJob: vi.fn(),
  getDistributionJobStatus: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildRequest(
  query = "",
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/admin/budju-trading${query}`, init);
}

describe("auth gate", () => {
  it("GET 401 without admin auth + without CRON_SECRET", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
  });

  it("GET ?action=process_distribution allows cron with x-vercel-cron-secret", async () => {
    process.env.CRON_SECRET = "secret-token";
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { processDistributionJob } = await import("@/lib/trading/budju");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (processDistributionJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      transfersExecuted: 5,
    });

    const { GET } = await import("./route");
    const res = await GET(
      await buildRequest("?action=process_distribution", {
        headers: { "x-vercel-cron-secret": "secret-token" },
      }),
    );
    expect(res.status).not.toBe(401);
    expect(processDistributionJob).toHaveBeenCalled();
  });

  it("POST 401 without admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET actions (admin)", () => {
  beforeEach(async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it("default action=dashboard calls getBudjuDashboard", async () => {
    const { getBudjuDashboard } = await import("@/lib/trading/budju");
    (getBudjuDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
      treasury_sol: 5,
      treasury_budju: 10000,
    });

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.treasury_sol).toBe(5);
    expect(body).toHaveProperty("jupiter_api_key_set");
  });

  it("?action=config returns wrapped config", async () => {
    const { getBudjuConfig } = await import("@/lib/trading/budju");
    (getBudjuConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: "true",
    });

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=config"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.enabled).toBe("true");
  });

  it("?action=distribution_status passes job_id to lib", async () => {
    const { getDistributionJobStatus } = await import("@/lib/trading/budju");
    (getDistributionJobStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "active",
    });

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=distribution_status&job_id=abc"));
    expect(res.status).toBe(200);
    expect(getDistributionJobStatus).toHaveBeenCalledWith("abc");
  });
});

describe("POST actions (admin)", () => {
  beforeEach(async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it("update_config calls setBudjuConfig for each ALLOWED key, ignores rest", async () => {
    const { setBudjuConfig } = await import("@/lib/trading/budju");
    (setBudjuConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "update_config",
          updates: {
            daily_budget_usd: "100",
            ignored_key: "nope",
            max_trade_usd: "10",
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    // Allowed keys come through; ignored_key does NOT
    expect(setBudjuConfig).toHaveBeenCalledWith("daily_budget_usd", "100");
    expect(setBudjuConfig).toHaveBeenCalledWith("max_trade_usd", "10");
    expect(setBudjuConfig).not.toHaveBeenCalledWith("ignored_key", "nope");
  });

  it("generate_wallets caps count at 30", async () => {
    const { generatePersonaWallets } = await import("@/lib/trading/budju");
    (generatePersonaWallets as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: 30,
    });

    const { POST } = await import("./route");
    await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "generate_wallets", count: 9999 }),
      }),
    );

    const calls = (generatePersonaWallets as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toBe(30);
  });

  it("trigger_trades caps count at 20 + temporarily enables trading", async () => {
    const { executeBudjuTradeBatch, setBudjuConfig, getBudjuConfig } = await import(
      "@/lib/trading/budju"
    );
    (getBudjuConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: "false" });
    (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      trades: [],
      budget_remaining: 100,
      is_enabled: true,
    });
    (setBudjuConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { POST } = await import("./route");
    await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "trigger_trades", count: 9999 }),
      }),
    );

    expect(executeBudjuTradeBatch).toHaveBeenCalledWith(20);
    // Should have flipped to true, run, then flipped back to false
    expect(setBudjuConfig).toHaveBeenCalledWith("enabled", "true");
    expect(setBudjuConfig).toHaveBeenCalledWith("enabled", "false");
  });

  it("clear_failed_trades calls clearFailedTrades", async () => {
    const { clearFailedTrades } = await import("@/lib/trading/budju");
    (clearFailedTrades as ReturnType<typeof vi.fn>).mockResolvedValue(42);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "clear_failed_trades" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(42);
  });

  it("create_distribution passes config through to createDistributionJob", async () => {
    const { createDistributionJob } = await import("@/lib/trading/budju");
    (createDistributionJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: "job-1",
    });

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "create_distribution",
          config: { dryRun: false, solPerPersona: 0.003 },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(createDistributionJob).toHaveBeenCalledWith({
      dryRun: false,
      solPerPersona: 0.003,
    });
  });

  it("400 on unknown POST action", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "banana" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
