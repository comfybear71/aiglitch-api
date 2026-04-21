import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

type BlobEntry = {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: Date;
};

const listMock = {
  calls: [] as { prefix: string; cursor?: string }[],
  pages: new Map<
    string,
    Array<{ blobs: BlobEntry[]; hasMore?: boolean; cursor?: string } | Error>
  >(),
};

vi.mock("@vercel/blob", () => ({
  list: (opts: { prefix: string; cursor?: string; limit?: number }) => {
    listMock.calls.push({ prefix: opts.prefix, cursor: opts.cursor });
    const pages = listMock.pages.get(opts.prefix) ?? [];
    const next = pages.shift();
    if (!next) return Promise.resolve({ blobs: [], hasMore: false });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  listMock.calls = [];
  listMock.pages = new Map();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callGet(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/test-premiere-post", {
    method: "GET",
  });
  return mod.GET(req);
}

async function callPost(body?: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "POST",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/test-premiere-post", init);
  return mod.POST(req);
}

describe("GET /api/test-premiere-post", () => {
  it("401 when not admin", async () => {
    expect((await callGet(false)).status).toBe(401);
  });

  it("lists videos + detects type/genre per folder", async () => {
    listMock.pages.set("news", [
      {
        blobs: [
          {
            url: "https://blob.test/news/a.mp4",
            pathname: "news/a.mp4",
            size: 123,
            uploadedAt: new Date("2026-04-20"),
          },
        ],
        hasMore: false,
      },
    ]);
    listMock.pages.set("premiere/cooking_show", [
      {
        blobs: [
          {
            url: "https://blob.test/premiere/cooking_show/dish.mp4",
            pathname: "premiere/cooking_show/dish.mp4",
            size: 456,
            uploadedAt: new Date("2026-04-20"),
          },
        ],
        hasMore: false,
      },
    ]);
    listMock.pages.set("premiere", [
      {
        blobs: [
          {
            // non-video file — should be ignored
            url: "https://blob.test/premiere/poster.jpg",
            pathname: "premiere/poster.jpg",
            size: 1,
            uploadedAt: new Date("2026-04-20"),
          },
        ],
        hasMore: false,
      },
    ]);

    const res = await callGet();
    const body = (await res.json()) as {
      videos: Array<{
        pathname: string;
        detectedType: string;
        detectedGenre: string | null;
      }>;
      count: number;
      folders: string[];
    };
    expect(body.count).toBe(2);
    const news = body.videos.find((v) => v.pathname === "news/a.mp4");
    expect(news?.detectedType).toBe("news");
    expect(news?.detectedGenre).toBeNull();
    const cooking = body.videos.find((v) => v.pathname.includes("cooking_show"));
    expect(cooking?.detectedType).toBe("premiere");
    expect(cooking?.detectedGenre).toBe("cooking_channel");
  });

  it("deduplicates by URL across overlapping prefixes", async () => {
    listMock.pages.set("premiere", [
      {
        blobs: [
          {
            url: "https://blob.test/premiere/action/shared.mp4",
            pathname: "premiere/action/shared.mp4",
            size: 100,
            uploadedAt: new Date(),
          },
        ],
        hasMore: false,
      },
    ]);
    listMock.pages.set("premiere/action", [
      {
        blobs: [
          {
            url: "https://blob.test/premiere/action/shared.mp4",
            pathname: "premiere/action/shared.mp4",
            size: 100,
            uploadedAt: new Date(),
          },
        ],
        hasMore: false,
      },
    ]);
    const res = await callGet();
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(1);
  });

  it("prefix scan failure is isolated (other prefixes keep going)", async () => {
    listMock.pages.set("news", [new Error("scan 500")]);
    listMock.pages.set("premiere/action", [
      {
        blobs: [
          {
            url: "https://blob.test/premiere/action/ok.mp4",
            pathname: "premiere/action/ok.mp4",
            size: 1,
            uploadedAt: new Date(),
          },
        ],
      },
    ]);
    const res = await callGet();
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(1);
  });
});

describe("POST /api/test-premiere-post", () => {
  it("401 when not admin", async () => {
    expect((await callPost({}, false)).status).toBe(401);
  });

  it("500 when no active personas", async () => {
    fake.results.push([]);
    const res = await callPost({});
    expect(res.status).toBe(500);
  });

  it("videoUrl body → creates single premiere post", async () => {
    fake.results.push([{ id: "p-1", username: "stella" }]);
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await callPost({
      videoUrl: "https://blob.test/premiere/action/x.mp4",
      type: "premiere",
      genre: "scifi",
    });
    const body = (await res.json()) as { success: boolean; postId: string };
    expect(body.success).toBe(true);
    expect(body.postId).toBeTruthy();

    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(insert!.values).toContain("AIGlitchPremieres,AIGlitchScifi");
  });

  it("videoUrl body with type=news → news hashtag template", async () => {
    fake.results.push([{ id: "p-1", username: "stella" }]);
    fake.results.push([]); // INSERT
    fake.results.push([]); // UPDATE
    const res = await callPost({
      videoUrl: "https://blob.test/news/x.mp4",
      type: "news",
    });
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    // news hashtags are inlined as SQL literal
    expect(insert!.strings.join("?")).toContain("AIGlitchBreaking,AIGlitchNews");
  });

  it("bulk backfill retags existing premiere posts with genre tag", async () => {
    fake.results.push([{ id: "p-1", username: "stella" }]); // personas
    // untagged posts query
    fake.results.push([
      {
        id: "post-1",
        media_url: "https://blob.test/premiere/scifi/m1.mp4",
        hashtags: "AIGlitchPremieres",
      },
    ]);
    fake.results.push([]); // UPDATE hashtags
    fake.results.push([]); // existingUrls (no posts yet)
    // No new blobs to post — all prefixes return empty

    const res = await callPost({});
    const body = (await res.json()) as {
      success: boolean;
      retagged: number;
      created: number;
    };
    expect(body.success).toBe(true);
    expect(body.retagged).toBe(1);
    expect(body.created).toBe(0);

    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE posts SET hashtags"),
    );
    expect(update).toBeDefined();
    expect(update!.values).toContain("AIGlitchPremieres,AIGlitchScifi");
  });

  it("bulk backfill creates posts for unseen blob videos, skips seen", async () => {
    fake.results.push([{ id: "p-1", username: "stella" }]); // personas
    fake.results.push([]); // untagged query
    fake.results.push([
      { media_url: "https://blob.test/premiere/action/seen.mp4" },
    ]); // existingUrls

    listMock.pages.set("premiere/action", [
      {
        blobs: [
          {
            url: "https://blob.test/premiere/action/seen.mp4",
            pathname: "premiere/action/seen.mp4",
            size: 1,
            uploadedAt: new Date(),
          },
          {
            url: "https://blob.test/premiere/action/new.mp4",
            pathname: "premiere/action/new.mp4",
            size: 2,
            uploadedAt: new Date(),
          },
          {
            url: "https://blob.test/premiere/action/thumb.jpg",
            pathname: "premiere/action/thumb.jpg",
            size: 3,
            uploadedAt: new Date(),
          },
        ],
      },
    ]);
    // The new.mp4 triggers createPost → INSERT + UPDATE
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas

    const res = await callPost({});
    const body = (await res.json()) as {
      created: number;
      posts: { videoUrl: string }[];
    };
    expect(body.created).toBe(1);
    expect(body.posts[0]!.videoUrl).toBe(
      "https://blob.test/premiere/action/new.mp4",
    );
  });
});
