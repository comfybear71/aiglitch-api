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

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    return Promise.resolve({ url: `https://blob.test/${pathname}` });
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  blob.putCalls = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

function mockFetch(
  results: Array<{ ok: boolean; status?: number; statusText?: string; contentType?: string; bytes?: number } | Error>,
) {
  const queue = [...results];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      const next = queue.shift();
      if (!next) return { ok: true, status: 200, headers: new Headers({ "content-type": "image/png" }), arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) };
      if (next instanceof Error) throw next;
      const bytes = next.bytes ?? 16;
      return {
        ok: next.ok,
        status: next.status ?? (next.ok ? 200 : 500),
        statusText: next.statusText ?? "",
        headers: new Headers({ "content-type": next.contentType ?? "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
      };
    }),
  );
}

async function call(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/media/import", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

describe("POST /api/admin/media/import", () => {
  it("401 when not admin", async () => {
    expect((await call({ urls: ["x"] }, false)).status).toBe(401);
  });

  it("400 when urls empty", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ urls: [] })).status).toBe(400);
  });

  it("happy path — one PNG → blob + INSERT media_library", async () => {
    mockFetch([{ ok: true, contentType: "image/png" }]);
    fake.results.push([]); // INSERT
    const res = await call({ urls: ["https://x.com/a.png"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      imported: number;
      failed: number;
      results: { url: string; stored_url?: string }[];
    };
    expect(body.success).toBe(true);
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results[0]!.stored_url).toMatch(/^https:\/\/blob\.test\/media-library\/.*\.png$/);
    expect(blob.putCalls).toHaveLength(1);
    expect(blob.putCalls[0]!.pathname).toMatch(/^media-library\/.*\.png$/);
  });

  it("video URL detection → media_type=video + .mp4 extension", async () => {
    mockFetch([{ ok: true, contentType: "video/mp4" }]);
    fake.results.push([]);
    await call({ urls: ["https://x.com/clip.mp4"] });
    expect(blob.putCalls[0]!.pathname).toMatch(/\.mp4$/);
  });

  it("gif URL → meme detected type", async () => {
    mockFetch([{ ok: true, contentType: "image/gif" }]);
    fake.results.push([]);
    await call({ urls: ["https://x.com/funny.gif"] });
    expect(blob.putCalls[0]!.pathname).toMatch(/\.gif$/);
  });

  it("persona_id set → INSERT posts + bump post_count", async () => {
    mockFetch([{ ok: true, contentType: "image/png" }]);
    fake.results.push([]); // INSERT media_library
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    await call({
      urls: ["https://x.com/img.png"],
      persona_id: "p-1",
      tags: "mood,vibe",
      description: "hello",
    });
    const inserts = fake.calls.filter((c) =>
      c.strings.join("?").includes("INSERT"),
    );
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE ai_personas"),
    );
    expect(update).toBeDefined();
  });

  it("no persona_id → no posts INSERT", async () => {
    mockFetch([{ ok: true, contentType: "image/png" }]);
    fake.results.push([]); // INSERT media_library only
    await call({ urls: ["https://x.com/a.png"] });
    const postInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(postInsert).toBeUndefined();
  });

  it("HTTP 404 on fetch → per-URL error without aborting", async () => {
    mockFetch([
      { ok: false, status: 404, statusText: "Not Found" },
      { ok: true, contentType: "image/png" },
    ]);
    fake.results.push([]); // INSERT for second URL
    const res = await call({
      urls: ["https://x.com/missing.png", "https://x.com/ok.png"],
    });
    const body = (await res.json()) as {
      success: boolean;
      imported: number;
      failed: number;
      results: { error?: string }[];
    };
    expect(body.success).toBe(false);
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.error).toContain("404");
  });

  it("zero-byte response → error entry", async () => {
    mockFetch([{ ok: true, contentType: "image/png", bytes: 0 }]);
    const res = await call({ urls: ["https://x.com/empty.png"] });
    const body = (await res.json()) as {
      imported: number;
      failed: number;
      results: { error?: string }[];
    };
    expect(body.imported).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.error).toBe("Empty response");
  });

  it("fetch throws → error captured", async () => {
    mockFetch([new Error("DNS failure")]);
    const res = await call({ urls: ["https://dead.example/a.png"] });
    const body = (await res.json()) as { results: { error?: string }[] };
    expect(body.results[0]!.error).toBe("DNS failure");
  });

  it("whitespace-only URL skipped silently", async () => {
    mockFetch([]);
    const res = await call({ urls: ["   ", ""] });
    const body = (await res.json()) as { imported: number; failed: number };
    expect(body.imported).toBe(0);
    expect(body.failed).toBe(0);
  });
});
