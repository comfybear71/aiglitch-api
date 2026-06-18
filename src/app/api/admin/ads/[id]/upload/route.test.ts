/**
 * Tests for /api/admin/ads/[id]/upload — Vercel Blob client-upload token
 * handler. Mocks @vercel/blob/client so we don't actually call out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const getBriefMock = vi.fn();
const createAssetMock = vi.fn();
vi.mock("@/lib/content/ad-briefs", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/content/ad-briefs")>(
      "@/lib/content/ad-briefs",
    );
  return {
    ...actual,
    getBrief: (...a: unknown[]) => getBriefMock(...a),
    createAsset: (...a: unknown[]) => createAssetMock(...a),
  };
});

// Same vendor mock as meatlab upload tests.
type TokenOpts = {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  tokenPayload?: string;
};
const upload = {
  result: { type: "blob.generate-client-token", clientToken: "tok" } as unknown,
  capturedPath: "" as string,
  capturedOpts: null as TokenOpts | Error | null,
  shouldThrow: null as Error | null,
  simulateCompletion: null as
    | { url: string; pathname: string; contentType?: string; tokenPayload?: string }
    | null,
};
vi.mock("@vercel/blob/client", () => ({
  handleUpload: async (opts: {
    body: unknown;
    request: unknown;
    onBeforeGenerateToken: (pathname: string, clientPayload?: string | null) => Promise<TokenOpts>;
    onUploadCompleted: (args: {
      blob: { url: string; pathname: string; contentType?: string };
      tokenPayload?: string | null;
    }) => Promise<void>;
  }) => {
    if (upload.shouldThrow) throw upload.shouldThrow;
    const path =
      (opts.body as { payload?: { pathname?: string } })?.payload?.pathname ?? "ad-briefs/b-1/x.png";
    const cp =
      (opts.body as { payload?: { clientPayload?: string | null } })?.payload?.clientPayload ?? null;
    upload.capturedPath = path;
    try {
      upload.capturedOpts = await opts.onBeforeGenerateToken(path, cp);
    } catch (err) {
      upload.capturedOpts = err as Error;
      throw err;
    }
    if (upload.simulateCompletion) {
      await opts.onUploadCompleted({
        blob: {
          url: upload.simulateCompletion.url,
          pathname: upload.simulateCompletion.pathname,
          contentType: upload.simulateCompletion.contentType,
        },
        tokenPayload: upload.simulateCompletion.tokenPayload ?? null,
      });
    }
    return upload.result;
  },
}));

beforeEach(() => {
  mockIsAdmin = false;
  getBriefMock.mockReset();
  createAssetMock.mockReset();
  upload.result = { type: "blob.generate-client-token", clientToken: "tok" };
  upload.capturedPath = "";
  upload.capturedOpts = null;
  upload.shouldThrow = null;
  upload.simulateCompletion = null;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callPost(id: string, body: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/admin/ads/${id}/upload`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const ctx = { params: Promise.resolve({ id }) };
  return mod.POST(req, ctx);
}

describe("POST /api/admin/ads/[id]/upload", () => {
  it("401 when not admin", async () => {
    const res = await callPost("b-1", {});
    expect(res.status).toBe(401);
  });

  it("404 when brief doesn't exist", async () => {
    mockIsAdmin = true;
    getBriefMock.mockResolvedValue(null);
    const res = await callPost("missing", {
      type: "blob.generate-client-token",
      payload: { pathname: "ad-briefs/missing/x.png" },
    });
    expect(res.status).toBe(404);
  });

  it("accepts a path under ad-briefs/<id>/ and surfaces correct MIME + cap", async () => {
    mockIsAdmin = true;
    getBriefMock.mockResolvedValue({ id: "b-1", title: "T" });
    const res = await callPost("b-1", {
      type: "blob.generate-client-token",
      payload: { pathname: "ad-briefs/b-1/clip.mp4", callbackUrl: "x" },
    });
    expect(res.status).toBe(200);
    const opts = upload.capturedOpts as TokenOpts;
    expect(opts.allowedContentTypes).toContain("video/mp4");
    expect(opts.allowedContentTypes).toContain("application/octet-stream");
    expect(opts.maximumSizeInBytes).toBe(500 * 1024 * 1024);
    expect(opts.tokenPayload).toContain("b-1");
  });

  it("rejects a path that doesn't start with ad-briefs/<id>/", async () => {
    mockIsAdmin = true;
    getBriefMock.mockResolvedValue({ id: "b-1", title: "T" });
    const res = await callPost("b-1", {
      type: "blob.generate-client-token",
      payload: { pathname: "ad-briefs/b-2/x.png" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid upload path");
    expect(upload.capturedOpts).toBeInstanceOf(Error);
  });

  it("onUploadCompleted calls createAsset with the right asset_type for an MP4", async () => {
    mockIsAdmin = true;
    getBriefMock.mockResolvedValue({ id: "b-1", title: "T" });
    upload.simulateCompletion = {
      url: "https://blob.test/ad-briefs/b-1/clip.mp4",
      pathname: "ad-briefs/b-1/clip.mp4",
      contentType: "video/mp4",
      tokenPayload: JSON.stringify({ briefId: "b-1" }),
    };
    await callPost("b-1", {
      type: "blob.generate-client-token",
      payload: { pathname: "ad-briefs/b-1/clip.mp4" },
    });
    expect(createAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ad_brief_id: "b-1",
        asset_type: "video",
        blob_url: "https://blob.test/ad-briefs/b-1/clip.mp4",
        original_filename: "clip.mp4",
      }),
    );
  });

  it("onUploadCompleted classifies images correctly", async () => {
    mockIsAdmin = true;
    getBriefMock.mockResolvedValue({ id: "b-1", title: "T" });
    upload.simulateCompletion = {
      url: "https://blob.test/ad-briefs/b-1/poster.png",
      pathname: "ad-briefs/b-1/poster.png",
      contentType: "image/png",
      tokenPayload: JSON.stringify({ briefId: "b-1" }),
    };
    await callPost("b-1", {
      type: "blob.generate-client-token",
      payload: { pathname: "ad-briefs/b-1/poster.png" },
    });
    expect(createAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ asset_type: "image" }),
    );
  });
});
