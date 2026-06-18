/**
 * Tests for POST /api/admin/ads/[id]/generate — Ad Creator pipeline
 * trigger. The pipeline lib (`generateAdFromBrief`) is mocked so we
 * cover only the route's auth, body parsing, status code mapping,
 * and successful pass-through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const generateAdFromBriefMock = vi.fn();
vi.mock("@/lib/content/ad-creator", () => ({
  generateAdFromBrief: (...a: unknown[]) => generateAdFromBriefMock(...a),
}));

beforeEach(() => {
  mockIsAdmin = false;
  generateAdFromBriefMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callPost(briefId: string, body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method: "POST" };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(
    `http://localhost/api/admin/ads/${briefId}/generate`,
    init,
  );
  const ctx = { params: Promise.resolve({ id: briefId }) };
  return mod.POST(req, ctx);
}

describe("POST /api/admin/ads/[id]/generate", () => {
  it("401 when not admin", async () => {
    expect((await callPost("b-1")).status).toBe(401);
  });

  it("200 with the generation result on happy path", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockResolvedValue({
      status: "posted",
      video_url: "https://blob/final.mp4",
      post_id: "uuid",
      log: [{ step: "claude_script", status: "ok" }],
    });
    const res = await callPost("b-1", { maxCostUsd: 6 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; video_url: string };
    expect(body.status).toBe("posted");
    expect(body.video_url).toBe("https://blob/final.mp4");
    expect(generateAdFromBriefMock).toHaveBeenCalledWith(
      "b-1",
      expect.objectContaining({ maxCostUsd: 6 }),
    );
  });

  it("200 with status=failed when pipeline returns a failure result", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockResolvedValue({
      status: "failed",
      error: "HeyGen quota exceeded",
      log: [{ step: "heygen_anchor", status: "failed", error: "quota" }],
    });
    const res = await callPost("b-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("failed");
    expect(body.error).toContain("quota");
  });

  it("404 when brief not found", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockRejectedValue(new Error("Brief not found"));
    const res = await callPost("missing");
    expect(res.status).toBe(404);
  });

  it("503 when HEYGEN_API_KEY is missing", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockRejectedValue(new Error("HEYGEN_API_KEY not set"));
    const res = await callPost("b-1");
    expect(res.status).toBe(503);
  });

  it("503 when HeyGen avatar/voice config is missing", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockRejectedValue(
      new Error("HeyGen avatar id missing — set HEYGEN_NEWS_ANCHOR_AVATAR_ID or pass override"),
    );
    const res = await callPost("b-1");
    expect(res.status).toBe(503);
  });

  it("500 on unexpected pre-flight error", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockRejectedValue(new Error("Database unreachable"));
    const res = await callPost("b-1");
    expect(res.status).toBe(500);
  });

  it("accepts empty body and passes undefined overrides through", async () => {
    mockIsAdmin = true;
    generateAdFromBriefMock.mockResolvedValue({
      status: "posted",
      log: [],
    });
    const res = await callPost("b-1");
    expect(res.status).toBe(200);
    const opts = generateAdFromBriefMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.maxCostUsd).toBeUndefined();
    expect(opts.avatarId).toBeUndefined();
    expect(opts.voiceId).toBeUndefined();
  });
});
