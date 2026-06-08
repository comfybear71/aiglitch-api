import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TokenOpts = {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
};

const upload = {
  calls: [] as unknown[],
  tokenOptsByPath: [] as Array<{ pathname: string; opts: TokenOpts | Error }>,
  result: { type: "blob.generate-client-token", clientToken: "tok-y" } as unknown,
  throws: null as Error | null,
  // When set, simulates Vercel Blob invoking onUploadCompleted after upload.
  simulateCompletion: null as
    | { url: string; size: number; pathname: string }
    | null,
  completionThrows: false,
};

vi.mock("@vercel/blob/client", () => ({
  handleUpload: async (opts: {
    body: unknown;
    request: unknown;
    onBeforeGenerateToken: (
      pathname: string,
      clientPayload?: string | null,
    ) => Promise<TokenOpts>;
    onUploadCompleted: (args: {
      blob: { url: string; pathname: string; contentType?: string };
      tokenPayload?: string | null;
    }) => Promise<void>;
  }) => {
    upload.calls.push(opts.body);
    if (upload.throws) throw upload.throws;
    const pathname =
      (opts.body as { payload?: { pathname?: string } })?.payload?.pathname ??
      "meatlab/default.png";
    const clientPayload =
      (opts.body as { payload?: { clientPayload?: string | null } })?.payload
        ?.clientPayload ?? null;
    try {
      const captured = await opts.onBeforeGenerateToken(pathname, clientPayload);
      upload.tokenOptsByPath.push({ pathname, opts: captured });
    } catch (err) {
      upload.tokenOptsByPath.push({ pathname, opts: err as Error });
      throw err;
    }
    if (upload.simulateCompletion) {
      const sim = upload.simulateCompletion;
      // Mirror the Blob CDN contract: if onUploadCompleted throws,
      // handleUpload re-throws so the caller surfaces a 500.
      try {
        await opts.onUploadCompleted({
          blob: {
            url: sim.url,
            pathname: sim.pathname,
            contentType: "video/mp4",
          },
          tokenPayload: null,
        });
      } catch (err) {
        if (upload.completionThrows) throw err;
      }
    }
    return upload.result;
  },
}));

beforeEach(() => {
  upload.calls = [];
  upload.tokenOptsByPath = [];
  upload.result = { type: "blob.generate-client-token", clientToken: "tok-y" };
  upload.throws = null;
  upload.simulateCompletion = null;
  upload.completionThrows = false;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callPost(body: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/meatlab/upload", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

describe("POST /api/meatlab/upload", () => {
  it("accepts meatlab/ path and returns token", async () => {
    const res = await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "meatlab/hero.png",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    expect(res.status).toBe(200);
    const last = upload.tokenOptsByPath.at(-1)!;
    expect(last.opts).not.toBeInstanceOf(Error);
    const opts = last.opts as TokenOpts;
    expect(opts.allowedContentTypes).toContain("video/mp4");
    expect(opts.allowedContentTypes).toContain("image/heic");
    expect(opts.maximumSizeInBytes).toBe(100 * 1024 * 1024);
  });

  it("accepts avatars/ path", async () => {
    const res = await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "avatars/user.jpg",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    expect(res.status).toBe(200);
    const last = upload.tokenOptsByPath.at(-1)!;
    expect(last.opts).not.toBeInstanceOf(Error);
  });

  it("rejects arbitrary path outside meatlab/ or avatars/", async () => {
    const res = await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "secrets/config.json",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid upload path");
  });

  it("handleUpload exception → 400 with error message", async () => {
    upload.throws = new Error("bad token request");
    const res = await callPost({ type: "blob.generate-client-token" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad token request");
  });

  // ── New coverage for the observability + hardening pass ────────

  it("logs structured token-rejection line for bad path", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "elsewhere/x.png",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    const messages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          m.includes("[meatlab/upload] token rejected") &&
          m.includes("Invalid upload path"),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("allowedContentTypes covers video/x-matroska + application/octet-stream", async () => {
    const res = await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "meatlab/clip.mkv",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    expect(res.status).toBe(200);
    const opts = upload.tokenOptsByPath.at(-1)!.opts as TokenOpts;
    expect(opts.allowedContentTypes).toContain("video/x-matroska");
    expect(opts.allowedContentTypes).toContain("application/octet-stream");
  });

  it("onUploadCompleted logs blob url + pathname + contentType", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    upload.simulateCompletion = {
      url: "https://blob.test/meatlab/clip.mp4",
      pathname: "meatlab/clip.mp4",
      size: 1234567,
    };
    const res = await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "meatlab/clip.mp4",
        callbackUrl: "https://x.test",
        clientPayload: null,
        multipart: false,
      },
    });
    expect(res.status).toBe(200);
    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          m.includes("[meatlab/upload] upload complete") &&
          m.includes("url=https://blob.test/meatlab/clip.mp4") &&
          m.includes("pathname=meatlab/clip.mp4") &&
          m.includes("contentType=video/mp4"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it("token-request log includes pathname + contentType", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callPost({
      type: "blob.generate-client-token",
      payload: {
        pathname: "meatlab/clip.mp4",
        callbackUrl: "https://x.test",
        clientPayload: "video/mp4",
        multipart: false,
      },
    });
    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          m.includes("[meatlab/upload] token request") &&
          m.includes("pathname=meatlab/clip.mp4") &&
          m.includes("contentType=video/mp4"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });
});
