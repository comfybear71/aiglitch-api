import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

type HandleUploadCall = { body: unknown; request: unknown };
const upload = {
  calls: [] as HandleUploadCall[],
  tokenOpts: null as Record<string, unknown> | null,
  result: { type: "blob.generate-client-token", clientToken: "token-xyz" } as unknown,
  throws: null as Error | null,
};

vi.mock("@vercel/blob/client", () => ({
  handleUpload: async (opts: {
    body: unknown;
    request: unknown;
    onBeforeGenerateToken: () => Promise<Record<string, unknown>>;
  }) => {
    upload.calls.push({ body: opts.body, request: opts.request });
    if (upload.throws) throw upload.throws;
    upload.tokenOpts = await opts.onBeforeGenerateToken();
    return upload.result;
  },
}));

beforeEach(() => {
  mockIsAdmin = false;
  upload.calls = [];
  upload.tokenOpts = null;
  upload.result = { type: "blob.generate-client-token", clientToken: "token-xyz" };
  upload.throws = null;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callJson(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/media/upload", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

async function callFormData(jsonBody: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const form = new FormData();
  form.set("__json", JSON.stringify(jsonBody));
  const req = new NextRequest("http://localhost/api/admin/media/upload", {
    method: "POST",
    body: form,
  });
  return mod.POST(req);
}

describe("POST /api/admin/media/upload", () => {
  it("401 when not admin", async () => {
    expect(
      (await callJson({ type: "blob.generate-client-token" }, false)).status,
    ).toBe(401);
  });

  it("JSON body passes through to handleUpload", async () => {
    const res = await callJson({
      type: "blob.generate-client-token",
      payload: {
        pathname: "media-library/test.png",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    expect(res.status).toBe(200);
    expect(upload.calls).toHaveLength(1);
    expect(upload.calls[0]!.body).toMatchObject({
      type: "blob.generate-client-token",
    });
  });

  it("multipart/form-data body parses __json key", async () => {
    const res = await callFormData({
      type: "blob.generate-client-token",
      payload: {
        pathname: "media-library/safari.mp4",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: true,
      },
    });
    expect(res.status).toBe(200);
    expect(upload.calls).toHaveLength(1);
    const body = upload.calls[0]!.body as { type: string };
    expect(body.type).toBe("blob.generate-client-token");
  });

  it("handleUpload exception → 400 with message", async () => {
    upload.throws = new Error("bad payload");
    const res = await callJson({ type: "blob.generate-client-token" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad payload");
  });

  it("onBeforeGenerateToken returns allowed types + 500MB cap + addRandomSuffix", async () => {
    await callJson({ type: "blob.generate-client-token" });
    expect(upload.tokenOpts).not.toBeNull();
    const allowedTypes = upload.tokenOpts!.allowedContentTypes as string[];
    expect(allowedTypes).toContain("video/mp4");
    expect(allowedTypes).toContain("image/heic");
    expect(allowedTypes).toContain("application/octet-stream");
    expect(upload.tokenOpts!.maximumSizeInBytes).toBe(500 * 1024 * 1024);
    expect(upload.tokenOpts!.addRandomSuffix).toBe(true);
  });
});
