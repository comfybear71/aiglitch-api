import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  mockIsAdmin = false;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/prompts/pipelines"));
}

describe("GET /api/admin/prompts/pipelines", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns pipeline catalog", async () => {
    mockIsAdmin = true;
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pipelines: { id: string; previewSupported: boolean }[];
      breakingNewsSamples: Record<string, string>;
    };
    expect(body.pipelines.length).toBeGreaterThanOrEqual(10);
    expect(body.pipelines.some((p) => p.id === "chaos-drops")).toBe(true);
    expect(body.breakingNewsSamples.intro).toContain("GLITCH NEWS NETWORK");
  });
});
