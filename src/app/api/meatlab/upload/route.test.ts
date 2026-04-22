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
};

vi.mock("@vercel/blob/client", () => ({
  handleUpload: async (opts: {
    body: unknown;
    request: unknown;
    onBeforeGenerateToken: (pathname: string) => Promise<TokenOpts>;
  }) => {
    upload.calls.push(opts.body);
    if (upload.throws) throw upload.throws;
    // Simulate Vercel Blob calling onBeforeGenerateToken with the uploaded pathname
    const pathname =
      (opts.body as { payload?: { pathname?: string } })?.payload?.pathname ??
      "meatlab/default.png";
    try {
      const captured = await opts.onBeforeGenerateToken(pathname);
      upload.tokenOptsByPath.push({ pathname, opts: captured });
    } catch (err) {
      upload.tokenOptsByPath.push({ pathname, opts: err as Error });
      throw err;
    }
    return upload.result;
  },
}));

beforeEach(() => {
  upload.calls = [];
  upload.tokenOptsByPath = [];
  upload.result = { type: "blob.generate-client-token", clientToken: "tok-y" };
  upload.throws = null;
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
});
