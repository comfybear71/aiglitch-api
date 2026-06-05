/**
 * Smoke tests for /api/admin/breaking-news — auth gate + action router.
 *
 * The underlying state + brand-asset logic is covered in
 * src/lib/content/breaking-news.test.ts; here we just verify the route
 * wires actions to the right lib functions and gates GET/POST on admin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isAdminAuthenticatedMock = vi.fn();
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: (...a: unknown[]) => isAdminAuthenticatedMock(...a),
}));

const getBreakingNewsStatusMock = vi.fn();
const setBreakingNewsEnabledMock = vi.fn();
const ensureBrandAssetsMock = vi.fn();
const forceTriggerBreakingNewsMock = vi.fn();
vi.mock("@/lib/content/breaking-news", () => ({
  getBreakingNewsStatus: () => getBreakingNewsStatusMock(),
  setBreakingNewsEnabled: (v: boolean) => setBreakingNewsEnabledMock(v),
  ensureBrandAssets: () => ensureBrandAssetsMock(),
  forceTriggerBreakingNews: (n?: number) => forceTriggerBreakingNewsMock(n),
}));

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  isAdminAuthenticatedMock.mockReset();
  getBreakingNewsStatusMock.mockReset();
  setBreakingNewsEnabledMock.mockReset();
  ensureBrandAssetsMock.mockReset();
  forceTriggerBreakingNewsMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function buildRequest(init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/admin/breaking-news", init);
}

describe("GET", () => {
  it("401 without admin auth", async () => {
    isAdminAuthenticatedMock.mockResolvedValue(false);
    const { GET } = await import("./route");
    expect((await GET(await buildRequest())).status).toBe(401);
  });

  it("200 with status payload", async () => {
    isAdminAuthenticatedMock.mockResolvedValue(true);
    getBreakingNewsStatusMock.mockResolvedValue({
      enabled: true,
      dailyCap: 2,
      count: 1,
      remaining: 1,
      intro_url: "i",
      outro_url: "o",
    });
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });
});

describe("POST", () => {
  beforeEach(() => isAdminAuthenticatedMock.mockResolvedValue(true));

  it("toggle flips current state", async () => {
    getBreakingNewsStatusMock.mockResolvedValue({ enabled: true } as ReturnType<
      typeof getBreakingNewsStatusMock
    >);
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "toggle" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(setBreakingNewsEnabledMock).toHaveBeenCalledWith(false);
  });

  it("enable / disable set explicit states", async () => {
    const { POST } = await import("./route");
    await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ action: "enable" }) }),
    );
    expect(setBreakingNewsEnabledMock).toHaveBeenCalledWith(true);

    await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ action: "disable" }) }),
    );
    expect(setBreakingNewsEnabledMock).toHaveBeenCalledWith(false);
  });

  it("reset_daily_count UPSERTs count=0", async () => {
    fake.results = [[]];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "reset_daily_count" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 0 });
  });

  it("regenerate_brand clears cache then re-runs ensureBrandAssets", async () => {
    fake.results = [[]]; // DELETE
    ensureBrandAssetsMock.mockResolvedValue({
      introUrl: "https://blob.test/intro.mp4",
      outroUrl: "https://blob.test/outro.mp4",
    });
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "regenerate_brand" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(ensureBrandAssetsMock).toHaveBeenCalled();
    expect((await res.json()).introUrl).toBe("https://blob.test/intro.mp4");
  });

  it("force_trigger calls forceTriggerBreakingNews (default max=1)", async () => {
    forceTriggerBreakingNewsMock.mockResolvedValue([
      { topic_id: "t1", status: "posted", video_url: "https://blob/v.mp4", post_id: "p1" },
    ]);
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "force_trigger" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results[0].status).toBe("posted");
    expect(forceTriggerBreakingNewsMock).toHaveBeenCalledWith(1);
  });

  it("force_trigger respects max_topics override (clamped 1-2)", async () => {
    forceTriggerBreakingNewsMock.mockResolvedValue([]);
    const { POST } = await import("./route");
    await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "force_trigger", max_topics: 5 }),
      }),
    );
    // Clamped to 2 (the daily cap is 2 so requesting more is pointless)
    expect(forceTriggerBreakingNewsMock).toHaveBeenCalledWith(2);
  });

  it("400 on unknown action", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ action: "banana" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: "{not-json" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST 401 without admin", async () => {
    isAdminAuthenticatedMock.mockResolvedValue(false);
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ action: "toggle" }) }),
    );
    expect(res.status).toBe(401);
  });
});
