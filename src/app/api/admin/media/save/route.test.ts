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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callJson(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/media/save", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

async function callForm(fields: Record<string, string>, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new NextRequest("http://localhost/api/admin/media/save", {
    method: "POST",
    body: form,
  });
  return mod.POST(req);
}

describe("POST /api/admin/media/save", () => {
  it("401 when not admin", async () => {
    expect((await callJson({ url: "x" }, false)).status).toBe(401);
  });

  it("400 when url missing", async () => {
    expect((await callJson({})).status).toBe(400);
  });

  it("403 when non-Architect tries to upload a logo", async () => {
    const res = await callJson({
      url: "https://blob.test/a.png",
      media_type: "logo",
      persona_id: "p-random",
    });
    expect(res.status).toBe(403);
  });

  it("Architect CAN upload logos", async () => {
    fake.results.push([]); // INSERT media_library
    const res = await callJson({
      url: "https://blob.test/logo.png",
      media_type: "logo",
      persona_id: "glitch-000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: string };
    expect(body.success).toBe(true);
    // media_type was resolved from logo → image for a .png extension
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO media_library"),
    );
    expect(insert!.values).toContain("image");
  });

  it("image URL without persona_id skips post creation", async () => {
    fake.results.push([]); // INSERT media_library
    const res = await callJson({ url: "https://blob.test/a.png" });
    const body = (await res.json()) as { success: boolean; posted?: boolean };
    expect(body.success).toBe(true);
    expect(body.posted).toBeUndefined();
    // no INSERT INTO posts call
    const postInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(postInsert).toBeUndefined();
  });

  it("persona_id → auto-creates a post + bumps post_count", async () => {
    fake.results.push([]); // INSERT media_library
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    const res = await callJson({
      url: "https://blob.test/funny.gif",
      persona_id: "p-1",
      tags: "funny,meme",
      description: "a great gif",
    });
    const body = (await res.json()) as {
      success: boolean;
      posted: boolean;
      spreading?: unknown;
    };
    expect(body.posted).toBe(true);
    // non-Architect → no `spreading` key
    expect(body.spreading).toBeUndefined();

    const postInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(postInsert).toBeDefined();
    // gif detected → media_type meme
    expect(postInsert!.values).toContain("meme");
    expect(postInsert!.values).toContain("meme"); // media_type column
    expect(postInsert!.values).toContain("funny,meme"); // hashtags
    expect(postInsert!.values).toContain("a great gif"); // caption
  });

  it("video URL detection → media_type=video on post row", async () => {
    fake.results.push([]); // INSERT media_library
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE ai_personas
    await callJson({
      url: "https://blob.test/clip.mp4",
      persona_id: "p-1",
    });
    const postInsert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO posts"),
    );
    expect(postInsert!.values).toContain("video");
  });

  it("Architect persona → spreading:[] placeholder (marketing deferred)", async () => {
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    const res = await callJson({
      url: "https://blob.test/architect-post.png",
      persona_id: "glitch-000",
    });
    const body = (await res.json()) as {
      posted: boolean;
      spreading: unknown;
    };
    expect(body.posted).toBe(true);
    expect(body.spreading).toEqual([]);
  });

  it("post creation failure still returns 200 with warning", async () => {
    fake.results.push([]); // INSERT media_library
    fake.results.push(new Error("FK violation")); // INSERT posts
    const res = await callJson({
      url: "https://blob.test/x.png",
      persona_id: "p-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      warning: string;
      posted?: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.warning).toContain("FK violation");
  });

  it("media_library INSERT failure → 500", async () => {
    fake.results.push(new Error("DB down"));
    const res = await callJson({ url: "https://blob.test/x.png" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("DB down");
  });

  it("multipart/form-data body works (Safari fallback)", async () => {
    fake.results.push([]);
    const res = await callForm({
      url: "https://blob.test/safari.png",
      media_type: "image",
    });
    expect(res.status).toBe(200);
  });

  it("explicit media_type=video overrides extension", async () => {
    fake.results.push([]); // INSERT media_library
    await callJson({
      url: "https://blob.test/no-extension",
      media_type: "video",
    });
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO media_library"),
    );
    expect(insert!.values).toContain("video");
  });
});
