import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

// ── Blob mock — each `put` / `listBlobs` call drains from a queue ──
type BlobResult = { url: string } | Error;
type ListResult = { blobs: { pathname: string; url: string; size: number }[] } | Error;

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResults: [] as BlobResult[],
  listCalls: [] as { prefix?: string }[],
  listResults: [] as ListResult[],
  delCalls: [] as string[],
  delShouldThrow: false,
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    const next = blob.putResults.shift();
    if (!next) return Promise.resolve({ url: `https://blob.test/${pathname}` });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
  list: (opts: { prefix?: string }) => {
    blob.listCalls.push(opts);
    const next = blob.listResults.shift();
    if (!next) return Promise.resolve({ blobs: [] });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
  del: (url: string) => {
    blob.delCalls.push(url);
    return blob.delShouldThrow ? Promise.reject(new Error("blob del failed")) : Promise.resolve();
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  blob.putCalls = [];
  blob.putResults = [];
  blob.listCalls = [];
  blob.listResults = [];
  blob.delCalls = [];
  blob.delShouldThrow = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

type CallInit = { headers?: HeadersInit; body?: BodyInit };

async function call(
  method: "GET" | "POST" | "PUT",
  url = "http://localhost/api/admin/blob-upload",
  init?: CallInit,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  // NextRequest strips auto-set Content-Type on FormData bodies. Build a
  // native Request (undici assigns the multipart boundary there), then
  // materialise to a Buffer + explicit headers so NextRequest preserves
  // the boundary through to `request.formData()`.
  let req: InstanceType<typeof NextRequest>;
  if (init?.body instanceof FormData) {
    const native = new Request(url, { method, body: init.body });
    const buf = Buffer.from(await native.arrayBuffer());
    req = new NextRequest(url, {
      method,
      body: buf,
      headers: { "content-type": native.headers.get("content-type") ?? "" },
    });
  } else {
    req = new NextRequest(url, { method, ...init });
  }
  if (method === "GET") return mod.GET(req);
  if (method === "POST") return mod.POST(req);
  return mod.PUT(req);
}

describe("GET /api/admin/blob-upload — default list", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("aggregates video counts across VALID_FOLDERS", async () => {
    mockIsAdmin = true;
    // 11 folders in VALID_FOLDERS — seed each with empty list then one with a video.
    blob.listResults = [
      { blobs: [] }, // news
      { blobs: [{ pathname: "premiere/action/a.mp4", url: "https://blob.test/a.mp4", size: 100 }] },
      { blobs: [] }, // scifi
      { blobs: [] }, // romance
      { blobs: [] }, // family
      { blobs: [] }, // horror
      { blobs: [] }, // comedy
      { blobs: [] }, // drama
      { blobs: [] }, // documentary
      { blobs: [] }, // cooking_show
      { blobs: [] }, // campaigns
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: Record<string, { count: number; totalSize: number }>;
      total: number;
      validFolders: string[];
    };
    expect(body.total).toBe(1);
    expect(body.folders["premiere/action"].count).toBe(1);
    expect(body.folders["premiere/action"].totalSize).toBe(100);
    expect(body.validFolders).toContain("news");
  });

  it("non-video extensions are filtered out", async () => {
    mockIsAdmin = true;
    // First folder has one .mp4 and one .txt — only .mp4 should count.
    blob.listResults = [
      {
        blobs: [
          { pathname: "news/good.mp4", url: "https://blob.test/good.mp4", size: 10 },
          { pathname: "news/readme.txt", url: "https://blob.test/readme.txt", size: 1 },
        ],
      },
      ...Array(10).fill({ blobs: [] }),
    ];
    const res = await call("GET");
    const body = (await res.json()) as { total: number; folders: Record<string, { count: number }> };
    expect(body.total).toBe(1);
    expect(body.folders["news"].count).toBe(1);
  });

  it("folder with list error degrades to zero (not whole-response fail)", async () => {
    mockIsAdmin = true;
    blob.listResults = [
      new Error("prefix not found"),
      ...Array(10).fill({ blobs: [] }),
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: Record<string, { count: number }>; total: number };
    expect(body.folders["news"].count).toBe(0);
    expect(body.total).toBe(0);
  });
});

describe("GET /api/admin/blob-upload?action=share_grokified", () => {
  it("returns 0 newlyPosted when all images are already shared", async () => {
    mockIsAdmin = true;
    blob.listResults = [
      {
        blobs: [
          { pathname: "sponsors/grokified/budju-scene1-a.png", url: "https://blob.test/one.png", size: 1 },
        ],
      },
    ];
    fake.results = [[{ media_url: "https://blob.test/one.png" }]];
    const res = await call("GET", "http://localhost/api/admin/blob-upload?action=share_grokified");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { newlyPosted: number; alreadyPosted: number; total: number };
    expect(body.total).toBe(1);
    expect(body.alreadyPosted).toBe(1);
    expect(body.newlyPosted).toBe(0);
  });

  it("inserts a post for each new image and bumps post_count", async () => {
    mockIsAdmin = true;
    blob.listResults = [
      {
        blobs: [
          { pathname: "sponsors/grokified/budju-alpha.png", url: "https://blob.test/budju.png", size: 1 },
          { pathname: "sponsors/grokified/frenchie-beta.jpeg", url: "https://blob.test/frenchie.jpg", size: 1 },
          // filtered out — not an image
          { pathname: "sponsors/grokified/notes.txt", url: "https://blob.test/n.txt", size: 1 },
        ],
      },
    ];
    fake.results = [
      [],          // existing posts query (empty → everything is new)
      [], [],      // INSERT posts #1
      [], [],      // INSERT posts #2 + UPDATE ai_personas
    ];
    const res = await call("GET", "http://localhost/api/admin/blob-upload?action=share_grokified");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { newlyPosted: number; posts: { title: string }[] };
    expect(body.newlyPosted).toBe(2);
    expect(body.posts[0].title).toContain("BUDJU");
    expect(body.posts[1].title).toContain("FRENCHIE");
    // SELECT + (INSERT post + UPDATE persona_count) * 2 = 5 SQL calls
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls[1].strings.join("?")).toContain("INSERT INTO posts");
    expect(fake.calls[2].strings.join("?")).toContain("UPDATE ai_personas");
  });

  it("500 on list failure (error propagates to wrapper)", async () => {
    mockIsAdmin = true;
    blob.listResults = [new Error("blob list down")];
    const res = await call("GET", "http://localhost/api/admin/blob-upload?action=share_grokified");
    expect(res.status).toBe(500);
  });
});

describe("GET /api/admin/blob-upload?action=organize_sponsors", () => {
  it("attempts all three copies; per-copy failures surface in results", async () => {
    mockIsAdmin = true;
    // Stub fetch: first succeeds, second 404, third throws.
    const bodyBytes = new Uint8Array([1, 2, 3]);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(bodyBytes, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error("network down"));
    blob.putResults = [{ url: "https://blob.test/sponsors/frenchie/product-1.jpeg" }];

    const res = await call("GET", "http://localhost/api/admin/blob-upload?action=organize_sponsors");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; results: { destPath: string; url?: string; error?: string }[] };
    expect(body.success).toBe(false);
    expect(body.results).toHaveLength(3);
    expect(body.results[0].url).toBeTruthy();
    expect(body.results[1].error).toContain("404");
    expect(body.results[2].error).toBeTruthy();

    fetchSpy.mockRestore();
  });
});

describe("POST /api/admin/blob-upload", () => {
  function fd(folder: string, files: File[] = []): FormData {
    const f = new FormData();
    f.set("folder", folder);
    for (const file of files) f.append("files", file);
    return f;
  }

  it("401 when not admin", async () => {
    expect((await call("POST", undefined, { body: fd("news") })).status).toBe(401);
  });

  it("400 on invalid folder", async () => {
    mockIsAdmin = true;
    const res = await call("POST", undefined, { body: fd("premiere/space_opera") });
    expect(res.status).toBe(400);
  });

  it("400 when no files present", async () => {
    mockIsAdmin = true;
    const res = await call("POST", undefined, { body: fd("news") });
    expect(res.status).toBe(400);
  });

  it("uploads each file to {folder}/{cleanedName}", async () => {
    mockIsAdmin = true;
    const f1 = new File([new Uint8Array([1])], "cool vid.mp4", { type: "video/mp4" });
    const f2 = new File([new Uint8Array([2])], "dodgy/path.mp4", { type: "video/mp4" });
    blob.putResults = [
      { url: "https://blob.test/premiere/action/cool_vid.mp4" },
      { url: "https://blob.test/premiere/action/dodgy_path.mp4" },
    ];

    const res = await call("POST", undefined, { body: fd("premiere/action", [f1, f2]) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { uploaded: number; failed: number; folder: string; results: { name: string; url?: string }[] };
    expect(json.uploaded).toBe(2);
    expect(json.failed).toBe(0);
    expect(json.folder).toBe("premiere/action");
    expect(blob.putCalls[0].pathname).toBe("premiere/action/cool_vid.mp4");
    expect(blob.putCalls[1].pathname).toBe("premiere/action/dodgy_path.mp4");
  });

  it("per-file failure is isolated and surfaces in results", async () => {
    mockIsAdmin = true;
    const f = new File([new Uint8Array([1])], "boom.mp4", { type: "video/mp4" });
    blob.putResults = [new Error("disk full")];

    const res = await call("POST", undefined, { body: fd("news", [f]) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { uploaded: number; failed: number; results: { error?: string }[] };
    expect(json.uploaded).toBe(0);
    expect(json.failed).toBe(1);
    expect(json.results[0].error).toContain("disk full");
  });
});

describe("PUT /api/admin/blob-upload — copy by URL", () => {
  it("401 when not admin", async () => {
    expect(
      (
        await call("PUT", undefined, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceUrl: "a", destPath: "b" }),
        } as CallInit)
      ).status,
    ).toBe(401);
  });

  it("400 when neither copies nor sourceUrl/destPath provided", async () => {
    mockIsAdmin = true;
    const res = await call("PUT", undefined, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    } as CallInit);
    expect(res.status).toBe(400);
  });

  it("succeeds for single copy; surfaces download failures", async () => {
    mockIsAdmin = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }));
    blob.putResults = [{ url: "https://blob.test/dest/path.png" }];

    const res = await call("PUT", undefined, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://src/a.png", destPath: "dest/path.png" }),
    } as CallInit);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; results: { url?: string; sizeMb?: string }[] };
    expect(json.success).toBe(true);
    expect(json.results[0].url).toBe("https://blob.test/dest/path.png");
    expect(blob.putCalls[0].pathname).toBe("dest/path.png");

    fetchSpy.mockRestore();
  });

  it("bulk copies accumulate per-copy failures without aborting batch", async () => {
    mockIsAdmin = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    blob.putResults = [{ url: "https://blob.test/two.jpg" }];

    const res = await call("PUT", undefined, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        copies: [
          { sourceUrl: "https://src/one.jpg", destPath: "dest/one.jpg" },
          { sourceUrl: "https://src/two.jpg", destPath: "dest/two.jpg" },
        ],
      }),
    } as CallInit);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; results: { destPath: string; error?: string; url?: string }[] };
    expect(json.success).toBe(false);
    expect(json.results[0].error).toContain("500");
    expect(json.results[1].url).toBe("https://blob.test/two.jpg");

    fetchSpy.mockRestore();
  });
});
