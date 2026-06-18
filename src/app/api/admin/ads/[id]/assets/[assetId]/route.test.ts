/**
 * Tests for DELETE /api/admin/ads/[id]/assets/[assetId].
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const listAssetsForBriefMock = vi.fn();
const deleteAssetMock = vi.fn();
vi.mock("@/lib/content/ad-briefs", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/content/ad-briefs")>(
      "@/lib/content/ad-briefs",
    );
  return {
    ...actual,
    listAssetsForBrief: (...a: unknown[]) => listAssetsForBriefMock(...a),
    deleteAsset: (...a: unknown[]) => deleteAssetMock(...a),
  };
});

beforeEach(() => {
  mockIsAdmin = false;
  listAssetsForBriefMock.mockReset();
  deleteAssetMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callDelete(briefId: string, assetId: string) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/admin/ads/${briefId}/assets/${assetId}`,
    { method: "DELETE" },
  );
  const ctx = { params: Promise.resolve({ id: briefId, assetId }) };
  return mod.DELETE(req, ctx);
}

describe("DELETE /api/admin/ads/[id]/assets/[assetId]", () => {
  it("401 when not admin", async () => {
    expect((await callDelete("b-1", "a-1")).status).toBe(401);
  });

  it("404 when the asset doesn't belong to the brief", async () => {
    mockIsAdmin = true;
    listAssetsForBriefMock.mockResolvedValue([
      { id: "other-asset" },
    ]);
    const res = await callDelete("b-1", "a-1");
    expect(res.status).toBe(404);
    expect(deleteAssetMock).not.toHaveBeenCalled();
  });

  it("200 ok:true on a valid delete", async () => {
    mockIsAdmin = true;
    listAssetsForBriefMock.mockResolvedValue([
      { id: "a-1", ad_brief_id: "b-1" },
    ]);
    deleteAssetMock.mockResolvedValue(true);
    const res = await callDelete("b-1", "a-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404 when deleteAsset reports nothing was removed", async () => {
    mockIsAdmin = true;
    listAssetsForBriefMock.mockResolvedValue([{ id: "a-1" }]);
    deleteAssetMock.mockResolvedValue(false);
    expect((await callDelete("b-1", "a-1")).status).toBe(404);
  });
});
