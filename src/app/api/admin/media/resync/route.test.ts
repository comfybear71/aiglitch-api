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

type BlobEntry = { url: string; pathname: string };

const listMock = {
  calls: [] as { prefix: string; cursor?: string }[],
  /** prefix → sequence of ({blobs, cursor?}|Error) pages */
  pages: new Map<string, Array<{ blobs: BlobEntry[]; cursor?: string } | Error>>(),
};

vi.mock("@vercel/blob", () => ({
  list: (opts: { prefix: string; cursor?: string }) => {
    listMock.calls.push({ prefix: opts.prefix, cursor: opts.cursor });
    const pages = listMock.pages.get(opts.prefix) ?? [];
    const next = pages.shift();
    if (!next) return Promise.resolve({ blobs: [], cursor: undefined });
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
  process.env.BLOB_READ_WRITE_TOKEN = "blob-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  vi.restoreAllMocks();
});

async function call(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/media/resync", {
    method: "POST",
  });
  return mod.POST(req);
}

describe("POST /api/admin/media/resync", () => {
  it("401 when not admin", async () => {
    expect((await call(false)).status).toBe(401);
  });

  it("500 when BLOB_READ_WRITE_TOKEN missing", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    mockIsAdmin = true;
    expect((await call()).status).toBe(500);
  });

  it("all prefixes scanned, empty case returns zero counts", async () => {
    fake.results.push([]); // SELECT existing urls
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      synced: number;
      skipped: number;
      errors: number;
      already_in_db: number;
    };
    expect(body.synced).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.already_in_db).toBe(0);
    // 8 prefixes × 1 list call each (all empty) = 8 list calls
    expect(listMock.calls).toHaveLength(8);
  });

  it("registers new media blobs, skips existing URLs, counts by type", async () => {
    fake.results.push([{ url: "https://blob.test/media-library/existing.png" }]);
    listMock.pages.set("media-library/", [
      {
        blobs: [
          { url: "https://blob.test/media-library/existing.png", pathname: "media-library/existing.png" },
          { url: "https://blob.test/media-library/new.jpg", pathname: "media-library/new.jpg" },
          { url: "https://blob.test/media-library/clip.mp4", pathname: "media-library/clip.mp4" },
          { url: "https://blob.test/memes/funny.gif", pathname: "memes/funny.gif" },
          { url: "https://blob.test/media-library/random.txt", pathname: "media-library/random.txt" },
        ],
      },
    ]);
    // Two INSERTs for the two new media (jpg + mp4 + gif counted). Actually 3 inserts for new media:
    fake.results.push([]); // jpg insert
    fake.results.push([]); // mp4 insert
    fake.results.push([]); // gif insert

    const res = await call();
    const body = (await res.json()) as {
      synced: number;
      skipped: number;
      counts: { memes: number; images: number; videos: number };
      sample: string[];
    };
    expect(body.synced).toBe(3);
    expect(body.skipped).toBe(1);
    expect(body.counts).toEqual({ memes: 1, images: 1, videos: 1 });
    expect(body.sample.length).toBe(3);
  });

  it("logo heuristic tags the row with 'logo' prefix", async () => {
    fake.results.push([]); // no existing rows
    listMock.pages.set("logos/", [
      {
        blobs: [
          { url: "https://blob.test/logos/main-logo.png", pathname: "logos/main-logo.png" },
        ],
      },
    ]);
    fake.results.push([]); // INSERT
    await call();
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO media_library"),
    );
    expect(insert).toBeDefined();
    const tagsValue = insert!.values.find(
      (v) => typeof v === "string" && (v as string).startsWith("logo,"),
    );
    expect(tagsValue).toBeDefined();
  });

  it("prefix scan failure isolated — other prefixes keep running", async () => {
    fake.results.push([]); // existing
    listMock.pages.set("media-library/", [new Error("scan 500")]);
    listMock.pages.set("videos/", [
      {
        blobs: [
          { url: "https://blob.test/videos/clip.mp4", pathname: "videos/clip.mp4" },
        ],
      },
    ]);
    fake.results.push([]); // INSERT for clip.mp4
    const res = await call();
    const body = (await res.json()) as { synced: number };
    expect(body.synced).toBe(1);
  });

  it("INSERT failure bumps errors but keeps going", async () => {
    fake.results.push([]); // no existing
    listMock.pages.set("media-library/", [
      {
        blobs: [
          { url: "https://blob.test/a.png", pathname: "media-library/a.png" },
          { url: "https://blob.test/b.png", pathname: "media-library/b.png" },
        ],
      },
    ]);
    fake.results.push(new Error("INSERT failed"));
    fake.results.push([]);
    const res = await call();
    const body = (await res.json()) as {
      synced: number;
      errors: number;
    };
    expect(body.synced).toBe(1);
    expect(body.errors).toBe(1);
  });

  it("scanned URL is not double-counted across prefix overlap", async () => {
    fake.results.push([]); // no existing
    listMock.pages.set("media-library/", [
      {
        blobs: [{ url: "https://blob.test/shared.png", pathname: "media-library/shared.png" }],
      },
    ]);
    // The empty "" prefix shows the same blob
    listMock.pages.set("", [
      {
        blobs: [{ url: "https://blob.test/shared.png", pathname: "media-library/shared.png" }],
      },
    ]);
    fake.results.push([]); // first INSERT
    const res = await call();
    const body = (await res.json()) as { synced: number; skipped: number };
    expect(body.synced).toBe(1);
    expect(body.skipped).toBe(1); // second appearance in "" prefix
  });
});
