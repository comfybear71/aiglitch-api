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
  const req = new NextRequest("http://localhost/api/admin/blob-upload/upload", {
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
  const req = new NextRequest("http://localhost/api/admin/blob-upload/upload", {
    method: "POST",
    body: form,
  });
  return mod.POST(req);
}

describe("POST /api/admin/blob-upload/upload", () => {
  it("401 when not admin", async () => {
    expect(
      (await callJson({ type: "blob.generate-client-token" }, false)).status,
    ).toBe(401);
  });

  it("JSON body passes through", async () => {
    const res = await callJson({
      type: "blob.generate-client-token",
      payload: { pathname: "premiere/action/x.mp4" },
    });
    expect(res.status).toBe(200);
    expect(upload.calls).toHaveLength(1);
  });

  it("multipart __json body works (Safari fallback)", async () => {
    const res = await callFormData({
      type: "blob.generate-client-token",
      payload: { pathname: "premiere/comedy/y.mp4" },
    });
    expect(res.status).toBe(200);
    expect(upload.calls).toHaveLength(1);
  });

  it("token opts lock allowlist to 4 video types + 500MB + NO random suffix", async () => {
    await callJson({ type: "blob.generate-client-token" });
    const allowed = upload.tokenOpts!.allowedContentTypes as string[];
    expect(allowed).toEqual([
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-msvideo",
    ]);
    expect(upload.tokenOpts!.maximumSizeInBytes).toBe(500 * 1024 * 1024);
    // Keeps clean paths so detectGenreFromPath can infer from the folder
    expect(upload.tokenOpts!.addRandomSuffix).toBe(false);
  });

  it("handleUpload exception → 400 with error message", async () => {
    upload.throws = new Error("bad token request");
    const res = await callJson({ type: "blob.generate-client-token" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad token request");
  });
});
