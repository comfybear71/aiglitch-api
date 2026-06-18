/**
 * Tests for /api/admin/ads/[id] — read / update / soft-delete one brief.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const getBriefWithAssetsMock = vi.fn();
const updateBriefMock = vi.fn();
const softDeleteBriefMock = vi.fn();
vi.mock("@/lib/content/ad-briefs", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/content/ad-briefs")>(
      "@/lib/content/ad-briefs",
    );
  return {
    ...actual,
    getBriefWithAssets: (...a: unknown[]) => getBriefWithAssetsMock(...a),
    updateBrief: (...a: unknown[]) => updateBriefMock(...a),
    softDeleteBrief: (...a: unknown[]) => softDeleteBriefMock(...a),
  };
});

beforeEach(() => {
  mockIsAdmin = false;
  getBriefWithAssetsMock.mockReset();
  updateBriefMock.mockReset();
  softDeleteBriefMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(
  method: "GET" | "PATCH" | "DELETE",
  id: string,
  opts: { body?: unknown } = {},
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const req = new NextRequest(`http://localhost/api/admin/ads/${id}`, init);
  const ctx = { params: Promise.resolve({ id }) };
  if (method === "GET") return mod.GET(req, ctx);
  if (method === "PATCH") return mod.PATCH(req, ctx);
  return mod.DELETE(req, ctx);
}

describe("GET /api/admin/ads/[id]", () => {
  it("401 when not admin", async () => {
    expect((await call("GET", "x")).status).toBe(401);
  });

  it("404 when brief missing", async () => {
    mockIsAdmin = true;
    getBriefWithAssetsMock.mockResolvedValue(null);
    expect((await call("GET", "missing")).status).toBe(404);
  });

  it("200 with the brief + assets on happy path", async () => {
    mockIsAdmin = true;
    getBriefWithAssetsMock.mockResolvedValue({
      id: "b-1",
      title: "T",
      assets: [{ id: "a-1", asset_type: "image" }],
    });
    const res = await call("GET", "b-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      brief: { id: string; assets: Array<{ id: string }> };
    };
    expect(body.brief.id).toBe("b-1");
    expect(body.brief.assets[0]!.id).toBe("a-1");
  });
});

describe("PATCH /api/admin/ads/[id]", () => {
  it("401 when not admin", async () => {
    expect((await call("PATCH", "x", { body: { title: "y" } })).status).toBe(401);
  });

  it("400 on invalid JSON", async () => {
    mockIsAdmin = true;
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/ads/x", {
      method: "PATCH",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{not-json",
    });
    const ctx = { params: Promise.resolve({ id: "x" }) };
    expect((await mod.PATCH(req, ctx)).status).toBe(400);
  });

  it("400 on invalid status", async () => {
    mockIsAdmin = true;
    const res = await call("PATCH", "b-1", { body: { status: "banana" } });
    expect(res.status).toBe(400);
    expect(updateBriefMock).not.toHaveBeenCalled();
  });

  it("404 when row not found", async () => {
    mockIsAdmin = true;
    updateBriefMock.mockResolvedValue(null);
    expect(
      (await call("PATCH", "missing", { body: { title: "x" } })).status,
    ).toBe(404);
  });

  it("returns the updated brief", async () => {
    mockIsAdmin = true;
    updateBriefMock.mockResolvedValue({ id: "b-1", title: "new" });
    const res = await call("PATCH", "b-1", { body: { title: "new" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brief: { title: string } };
    expect(body.brief.title).toBe("new");
  });

  it("passes target_socials through and skips fields that aren't string-typed", async () => {
    mockIsAdmin = true;
    updateBriefMock.mockResolvedValue({ id: "b-1" });
    await call("PATCH", "b-1", {
      body: { title: "x", target_socials: "telegram,x", concept: 42 },
    });
    const patch = updateBriefMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.title).toBe("x");
    expect(patch.target_socials).toBe("telegram,x");
    // 42 isn't a string, so it should NOT have been propagated as concept
    expect(patch.concept).toBeUndefined();
  });
});

describe("DELETE /api/admin/ads/[id]", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", "x")).status).toBe(401);
  });

  it("404 when nothing to delete", async () => {
    mockIsAdmin = true;
    softDeleteBriefMock.mockResolvedValue(false);
    expect((await call("DELETE", "missing")).status).toBe(404);
  });

  it("200 ok:true on happy path", async () => {
    mockIsAdmin = true;
    softDeleteBriefMock.mockResolvedValue(true);
    const res = await call("DELETE", "b-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
