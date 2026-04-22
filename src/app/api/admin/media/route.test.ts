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

async function call(
  method: "GET" | "POST" | "DELETE",
  options: { query?: string; form?: FormData; body?: unknown; authed?: boolean } = {},
) {
  if (options.authed !== false) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string | FormData } = {
    method,
  };
  if (options.form) {
    init.body = options.form;
  } else if (options.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(options.body);
  }
  const url = `http://localhost/api/admin/media${options.query ?? ""}`;
  const req = new NextRequest(url, init);
  const handler = { GET: mod.GET, POST: mod.POST, DELETE: mod.DELETE }[method];
  return handler(req);
}

describe("GET", () => {
  it("401 when not admin", async () => {
    expect((await call("GET", { authed: false })).status).toBe(401);
  });

  it("default returns media list", async () => {
    fake.results.push([{ id: "m-1", url: "x", media_type: "image" }]);
    const res = await call("GET");
    const body = (await res.json()) as { media: unknown[] };
    expect(body.media).toHaveLength(1);
    // No stats queries fired
    expect(fake.calls).toHaveLength(1);
  });

  it("?stats=1 adds video_stats breakdowns", async () => {
    // Promise.all fires all 6 queries in parallel — seed in order
    fake.results.push([{ id: "m-1" }]); // media list
    fake.results.push([{ source: "grok-video", count: 5 }]); // by_source
    fake.results.push([{ post_type: "premiere", count: 3 }]); // by_type
    fake.results.push([{ day: "2026-04-21", count: 2 }]); // timeline
    fake.results.push([
      { username: "stella", display_name: "S", avatar_emoji: "✨", video_count: 7 },
    ]);
    fake.results.push([{ total: 10 }]); // totalVideos
    const res = await call("GET", { query: "?stats=1" });
    const body = (await res.json()) as {
      media: unknown[];
      video_stats: { total: number; by_source: unknown[]; top_personas: unknown[] };
    };
    expect(body.video_stats.total).toBe(10);
    expect(body.video_stats.by_source).toHaveLength(1);
    expect(body.video_stats.top_personas).toHaveLength(1);
  });
});

describe("POST", () => {
  it("401 when not admin", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
    expect((await call("POST", { authed: false, form })).status).toBe(401);
  });

  it("400 when no files", async () => {
    const form = new FormData();
    form.set("media_type", "image");
    expect((await call("POST", { form })).status).toBe(400);
  });

  it("403 when non-Architect uploads logo", async () => {
    const form = new FormData();
    form.set("media_type", "logo");
    form.set("persona_id", "someone-else");
    form.set("file", new File([new Uint8Array([1])], "logo.png", { type: "image/png" }));
    const res = await call("POST", { form });
    expect(res.status).toBe(403);
  });

  it("single image upload without persona_id → just INSERT media_library", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "pic.png", { type: "image/png" }));
    fake.results.push([]); // INSERT media_library
    const res = await call("POST", { form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploaded: number; results: unknown[] };
    expect(body.uploaded).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(blob.putCalls[0]!.pathname).toMatch(/^media-library\/.*\.png$/);
  });

  it("video ext detected → media_type=video + post INSERT when persona_id set", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" }));
    form.set("persona_id", "p-1");
    fake.results.push([]); // INSERT media_library
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    await call("POST", { form });
    const postInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(postInsert).toBeDefined();
    expect(postInsert!.values).toContain("video");
  });

  it("gif ext → meme media_type; logo upload path → logo/image/ folder", async () => {
    const form = new FormData();
    form.set("media_type", "logo");
    form.set("persona_id", "glitch-000"); // Architect allowed
    form.set("file", new File([new Uint8Array([1])], "brand.png", { type: "image/png" }));
    fake.results.push([]); // INSERT media_library
    fake.results.push([]); // INSERT posts (Architect has persona_id)
    fake.results.push([]); // UPDATE ai_personas
    const res = await call("POST", { form });
    const body = (await res.json()) as {
      uploaded: number;
      spreading: string[] | undefined;
    };
    expect(body.uploaded).toBe(1);
    expect(blob.putCalls[0]!.pathname).toMatch(/^logo\/image\//);
    // Architect path emits spreading placeholder
    expect(body.spreading).toEqual([]);
  });

  it("Safari fallback: empty file.type resolves from extension", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1])], "photo.heic", { type: "" }),
    );
    fake.results.push([]); // INSERT
    await call("POST", { form });
    const putOpts = blob.putCalls[0]!.opts as { contentType: string };
    expect(putOpts.contentType).toBe("image/heic");
  });
});

describe("DELETE", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", { authed: false, body: { id: "m-1" } })).status).toBe(
      401,
    );
  });

  it("400 when id missing", async () => {
    expect((await call("DELETE", { body: {} })).status).toBe(400);
  });

  it("happy path deletes the row", async () => {
    fake.results.push([]); // DELETE
    const res = await call("DELETE", { body: { id: "m-1" } });
    expect(res.status).toBe(200);
    const del = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM media_library"),
    );
    expect(del).toBeDefined();
  });
});
