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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/meatlab${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/meatlab", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns pending submissions + counts on happy path", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // ALTER posts add meatbag_author_id
      [],  // CREATE TABLE meatlab_submissions
      [],  // UPDATE backfill
      [
        { id: "s1", status: "pending", media_url: "u1", creator_name: "Alice" },
        { id: "s2", status: "pending", media_url: "u2", creator_name: null },
      ],
      [{ pending: 2, approved: 10, rejected: 1 }],
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      counts: { pending: number; approved: number };
      total: number;
      submissions: unknown[];
    };
    expect(body.status).toBe("pending");
    expect(body.total).toBe(2);
    expect(body.counts.approved).toBe(10);
  });

  it("clamps limit at 200", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], [], [], [{ pending: 0, approved: 0, rejected: 0 }]];
    await call("GET", { query: "?limit=999" });
    const listCall = fake.calls[3];
    expect(listCall.values).toContain(200);
  });
});

describe("POST /api/admin/meatlab — validation", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { body: { id: "s1", action: "approve" } })).status).toBe(401);
  });

  it("400 when id or action missing", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { body: {} })).status).toBe(400);
    expect((await call("POST", { body: { id: "s1" } })).status).toBe(400);
  });

  it("400 when action is not approve/reject", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { body: { id: "s1", action: "delete" } })).status).toBe(400);
  });
});

describe("POST /api/admin/meatlab — approve", () => {
  it("404 when submission not found", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // ALTER posts
      [],  // SELECT submission — empty
    ];
    const res = await call("POST", { body: { id: "missing", action: "approve" } });
    expect(res.status).toBe(404);
  });

  it("creates feed post under The Architect with meatbag_author_id", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // ALTER posts
      [{  // SELECT submission
        id: "s1",
        title: "My Art",
        description: "Cool piece",
        media_url: "https://x/y.png",
        media_type: "image",
        ai_tool: "Midjourney",
        user_id: "user-123",
        creator_name: "Alice",
        creator_username: "alice",
      }],
      [],  // INSERT post
      [],  // UPDATE submission
    ];
    const res = await call("POST", { body: { id: "s1", action: "approve" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { post_id: string; status: string; message: string };
    expect(body.status).toBe("approved");
    expect(body.post_id).toBeTruthy();
    expect(body.message).toContain("Alice");

    // Check the INSERT was to posts with glitch-000 + meatbag_author_id=user-123
    const insert = fake.calls[2];
    expect(insert.strings.join("?")).toContain("INSERT INTO posts");
    expect(insert.values).toContain("glitch-000");
    expect(insert.values).toContain("user-123");
  });

  it("returns 500 when feed post insert fails", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],
      [{
        id: "s1", title: "T", description: "D", media_url: "u", media_type: "image",
        ai_tool: null, user_id: null, creator_name: null, creator_username: null,
      }],
    ];
    fake.results.push(new Error("insert failed"));
    const res = await call("POST", { body: { id: "s1", action: "approve" } });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/admin/meatlab — reject", () => {
  it("sets status=rejected and optional reason", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("POST", {
      body: { id: "s1", action: "reject", reject_reason: "Low quality" },
    });
    expect(res.status).toBe(200);
    const update = fake.calls[0];
    expect(update.strings.join("?")).toContain("UPDATE meatlab_submissions");
    expect(update.values).toContain("Low quality");
  });
});
