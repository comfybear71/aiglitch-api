/**
 * Tests for /api/budju-trading (user-facing wrapper).
 *
 * The actual on-chain trade execution lives in lib/trading/budju (PR 1
 * v1.33.0). Here we test ONLY the route's contract:
 *   - Cron path requires action=cron AND a valid CRON_SECRET
 *   - Cron honors the BUDJU pause toggle (config.enabled !== "true")
 *   - POST requires admin auth
 *   - POST count is capped at 20
 *   - Underlying executeBudjuTradeBatch is mocked — devnet smoke tests
 *     the real on-chain behavior on the user side
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));
vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn(),
}));
vi.mock("@/lib/cron-handler", () => ({
  cronHandler: vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
    const r = (await fn()) as Record<string, unknown>;
    return { ...r, _cron_run_id: "test-id" };
  }),
}));
vi.mock("@/lib/trading/budju", () => ({
  executeBudjuTradeBatch: vi.fn(),
  getBudjuConfig: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/budju-trading${query}`, init);
}

describe("GET /api/budju-trading", () => {
  it("400 when action != cron", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/action=cron/);
  });

  it("401 when cron auth fails", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    const { NextResponse } = await import("next/server");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    expect(res.status).toBe(401);
  });

  it("cron path honors paused config (enabled !== 'true')", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    const { getBudjuConfig, executeBudjuTradeBatch } = await import("@/lib/trading/budju");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getBudjuConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: "false" });

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/paused/);
    expect(body.trades_executed).toBe(0);
    expect(executeBudjuTradeBatch).not.toHaveBeenCalled();
  });

  it("cron path executes a batch when enabled", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    const { getBudjuConfig, executeBudjuTradeBatch } = await import("@/lib/trading/budju");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getBudjuConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: "true" });
    (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      trades: [{ id: "t1" }, { id: "t2" }],
      budget_remaining: 100,
      is_enabled: true,
    });

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.trades_executed).toBe(2);
    expect(body.budget_remaining).toBe(100);
    // Batch size argument is random 3-7 — assert it falls in range.
    const batchArg = (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(batchArg).toBeGreaterThanOrEqual(3);
    expect(batchArg).toBeLessThanOrEqual(7);
  });
});

describe("POST /api/budju-trading", () => {
  it("401 without admin auth", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
  });

  it("happy path runs a batch with default count=5", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { executeBudjuTradeBatch } = await import("@/lib/trading/budju");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      trades: [{ id: "t1" }],
      budget_remaining: 200,
      is_enabled: true,
    });

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades_executed).toBe(1);

    // mock.calls accumulates across tests in the same file. Use the
    // most-recent invocation, which is this test's.
    const calls = (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toBe(5);
  });

  it("caps count at 20", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { executeBudjuTradeBatch } = await import("@/lib/trading/budju");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      trades: [],
      budget_remaining: 0,
      is_enabled: true,
    });

    const { POST } = await import("./route");
    await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ count: 9999 }),
      }),
    );

    const calls = (executeBudjuTradeBatch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toBe(20);
  });
});
