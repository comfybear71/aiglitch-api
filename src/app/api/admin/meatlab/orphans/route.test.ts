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

type BlobListResult = {
  blobs: Array<{ url: string; pathname: string; size: number; uploadedAt: string }>;
  hasMore: boolean;
  cursor?: string;
};
const listBlobsMock = vi.fn<(args: { prefix: string; limit: number; cursor?: string }) => Promise<BlobListResult>>();
vi.mock("@vercel/blob", () => ({
  list: (args: { prefix: string; limit: number; cursor?: string }) =>
    listBlobsMock(args),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  listBlobsMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGet() {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/meatlab/orphans");
  return mod.GET(req);
}

describe("GET /api/admin/meatlab/orphans", () => {
  it("401 when not admin", async () => {
    listBlobsMock.mockResolvedValue({ blobs: [], hasMore: false });
    const res = await callGet();
    expect(res.status).toBe(401);
  });

  it("returns empty orphan list when Blob is clean", async () => {
    mockIsAdmin = true;
    listBlobsMock.mockResolvedValue({ blobs: [], hasMore: false });
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0, orphans: [] });
    // No DB query should fire when no blobs are recent.
    expect(fake.calls.length).toBe(0);
  });

  it("ignores blobs older than 24h", async () => {
    mockIsAdmin = true;
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    listBlobsMock.mockResolvedValue({
      blobs: [
        {
          url: "https://blob.test/meatlab/old.mp4",
          pathname: "meatlab/old.mp4",
          size: 1000,
          uploadedAt: ancient,
        },
      ],
      hasMore: false,
    });
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0, orphans: [] });
  });

  it("returns blobs missing from meatlab_submissions as orphans", async () => {
    mockIsAdmin = true;
    const fresh = new Date().toISOString();
    listBlobsMock.mockResolvedValue({
      blobs: [
        {
          url: "https://blob.test/meatlab/a.mp4",
          pathname: "meatlab/a.mp4",
          size: 1000,
          uploadedAt: fresh,
        },
        {
          url: "https://blob.test/meatlab/b.mp4",
          pathname: "meatlab/b.mp4",
          size: 2000,
          uploadedAt: fresh,
        },
      ],
      hasMore: false,
    });
    // DB has a row for "a" but not "b"
    fake.results = [[{ media_url: "https://blob.test/meatlab/a.mp4" }]];

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      orphans: Array<{ url: string; size: number }>;
    };
    expect(body.count).toBe(1);
    expect(body.orphans[0]!.url).toBe("https://blob.test/meatlab/b.mp4");
    expect(body.orphans[0]!.size).toBe(2000);
  });

  it("paginates Blob list until hasMore goes false", async () => {
    mockIsAdmin = true;
    const fresh = new Date().toISOString();
    listBlobsMock
      .mockResolvedValueOnce({
        blobs: [
          {
            url: "https://blob.test/meatlab/p1.mp4",
            pathname: "meatlab/p1.mp4",
            size: 1,
            uploadedAt: fresh,
          },
        ],
        hasMore: true,
        cursor: "c1",
      })
      .mockResolvedValueOnce({
        blobs: [
          {
            url: "https://blob.test/meatlab/p2.mp4",
            pathname: "meatlab/p2.mp4",
            size: 1,
            uploadedAt: fresh,
          },
        ],
        hasMore: false,
      });
    fake.results = [[]]; // nothing registered → both orphans

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(2);
    expect(listBlobsMock).toHaveBeenCalledTimes(2);
  });

  it("500 when Blob list throws", async () => {
    mockIsAdmin = true;
    listBlobsMock.mockRejectedValue(new Error("blob down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blob down");
    errSpy.mockRestore();
  });
});
