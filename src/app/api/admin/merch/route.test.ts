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
  // mimic the neon tagged-template Promise — `.catch(() => {})` chained in
  // `ensureTable()` for CREATE INDEX needs to be a real Promise.
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResults: [] as ({ url: string } | Error)[],
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
  blob.delCalls = [];
  blob.delShouldThrow = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

// ensureTable runs 3 SQL calls: CREATE TABLE + 2 CREATE INDEX (both with
// `.catch(() => {})`). Seed 3 empties so real queries start from call[3].
function seedEnsureTable() {
  fake.results.unshift([], [], []);
}

async function call(
  method: "GET" | "POST",
  url = "http://localhost/api/admin/merch",
  body?: unknown,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/merch — list (default)", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns top 500 rows from merch_library", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([
      { id: "m1", source: "capture", image_url: "https://blob.test/m1.png", label: "hat" },
    ]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("m1");
    // Last call should be the SELECT, not an ensureTable CREATE.
    const last = fake.calls[fake.calls.length - 1];
    expect(last.strings.join("?")).toContain("FROM merch_library");
  });
});

describe("GET /api/admin/merch?action=videos", () => {
  it("clamps limit to [1, 200] and joins ai_personas", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([
      { id: "p1", content: "hi", media_url: "https://v.mp4", display_name: "Alpha" },
    ]);
    const res = await call("GET", "http://localhost/api/admin/merch?action=videos&limit=999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videos: unknown[] };
    expect(body.videos).toHaveLength(1);
    const select = fake.calls[fake.calls.length - 1];
    expect(select.strings.join("?")).toContain("FROM posts p");
    // limit is clamped to 200 — last template value is the limit.
    expect(select.values[select.values.length - 1]).toBe(200);
  });

  it("defaults limit to 60 when omitted or unparseable", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]);
    await call("GET", "http://localhost/api/admin/merch?action=videos&limit=abc");
    const select = fake.calls[fake.calls.length - 1];
    expect(select.values[select.values.length - 1]).toBe(60);
  });
});

describe("POST /api/admin/merch — capture", () => {
  it("401 when not admin", async () => {
    expect(
      (await call("POST", undefined, { action: "capture", image_data: "..." })).status,
    ).toBe(401);
  });

  it("400 when image_data missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "capture" });
    expect(res.status).toBe(400);
  });

  it("400 when image_data is not a valid data URL", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "capture", image_data: "plain-string" });
    expect(res.status).toBe(400);
  });

  it("uploads to merch/captures/{id}.{ext} and inserts with source='capture'", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // INSERT
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const res = await call("POST", undefined, {
      action: "capture",
      image_data: dataUrl,
      label: "glitch-hat",
      source_post_id: "p1",
      source_video_url: "https://v.mp4",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; image_url: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(blob.putCalls[0].pathname).toMatch(/^merch\/captures\/[0-9a-f-]{36}\.png$/i);
    const insert = fake.calls[fake.calls.length - 1];
    expect(insert.strings.join("?")).toContain("INSERT INTO merch_library");
    // 'capture' and 'video-frame' are SQL literals, not template params.
    expect(insert.strings.join("?")).toContain("'capture'");
    expect(insert.strings.join("?")).toContain("'video-frame'");
  });
});

describe("POST /api/admin/merch — generate (Phase 5 deferral)", () => {
  it("returns 501 with an explanatory reason", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "generate", prompt: "a glitch hoodie" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toContain("@/lib/ai/");
  });

  it("does not hit the Blob API", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    await call("POST", undefined, { action: "generate", prompt: "anything" });
    expect(blob.putCalls).toHaveLength(0);
  });
});

describe("POST /api/admin/merch — update", () => {
  it("400 when id missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "update", label: "x" });
    expect(res.status).toBe(400);
  });

  it("updates label/category on merch_library", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]);
    const res = await call("POST", undefined, {
      action: "update",
      id: "m1",
      label: "renamed",
      category: "sticker",
    });
    expect(res.status).toBe(200);
    const update = fake.calls[fake.calls.length - 1];
    expect(update.strings.join("?")).toContain("UPDATE merch_library");
  });
});

describe("POST /api/admin/merch — delete", () => {
  it("400 when id missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "delete" });
    expect(res.status).toBe(400);
  });

  it("deletes blob + row, returns success", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([{ image_url: "https://blob.test/existing.png" }]); // SELECT
    fake.results.push([]); // DELETE
    const res = await call("POST", undefined, { action: "delete", id: "m1" });
    expect(res.status).toBe(200);
    expect(blob.delCalls).toEqual(["https://blob.test/existing.png"]);
    const del = fake.calls[fake.calls.length - 1];
    expect(del.strings.join("?")).toContain("DELETE FROM merch_library");
  });

  it("swallows blob.del errors but still deletes the row (legacy parity)", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    blob.delShouldThrow = true;
    fake.results.push([{ image_url: "https://blob.test/doomed.png" }]);
    fake.results.push([]);
    const res = await call("POST", undefined, { action: "delete", id: "m1" });
    expect(res.status).toBe(200);
    const del = fake.calls[fake.calls.length - 1];
    expect(del.strings.join("?")).toContain("DELETE FROM merch_library");
  });

  it("row absent: no blob.del, DB delete still runs", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // SELECT returns no rows
    fake.results.push([]); // DELETE
    const res = await call("POST", undefined, { action: "delete", id: "ghost" });
    expect(res.status).toBe(200);
    expect(blob.delCalls).toHaveLength(0);
  });
});

describe("POST /api/admin/merch — unknown action", () => {
  it("returns 400", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "mystery" });
    expect(res.status).toBe(400);
  });
});
