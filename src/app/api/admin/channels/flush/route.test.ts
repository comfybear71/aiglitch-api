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

const gen = {
  calls: [] as unknown[],
  queue: [] as (string | Error)[],
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: unknown) => {
    gen.calls.push(opts);
    const next = gen.queue.shift();
    if (next === undefined) return Promise.resolve("[]");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  gen.calls = [];
  gen.queue = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callGet(query = "", authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/admin/channels/flush${query}`,
    { method: "GET" },
  );
  return mod.GET(req);
}

async function callDelete(body?: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "DELETE",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(
    "http://localhost/api/admin/channels/flush",
    init,
  );
  return mod.DELETE(req);
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
  const req = new NextRequest(
    "http://localhost/api/admin/channels/flush",
    init,
  );
  return mod.POST(req);
}

describe("GET /api/admin/channels/flush", () => {
  it("401 when not admin", async () => {
    expect((await callGet("?channel_id=c", false)).status).toBe(401);
  });

  it("400 when channel_id missing", async () => {
    expect((await callGet("")).status).toBe(400);
  });

  it("404 when channel not found", async () => {
    fake.results.push([]); // channel lookup empty
    expect((await callGet("?channel_id=missing")).status).toBe(404);
  });

  it("happy path returns posts + flags broken video", async () => {
    fake.results.push([{ id: "c1", name: "AI News", slug: "ai-news" }]);
    fake.results.push([
      {
        id: "p-1",
        content: "First line\n\nsecond",
        media_type: "video",
        media_url: "https://b.test/v.mp4",
        created_at: "2026-04-21",
        username: "news",
        display_name: "News Bot",
        avatar_emoji: "📰",
      },
      {
        id: "p-broken",
        content: "",
        media_type: "video",
        media_url: null,
        created_at: "2026-04-21",
        username: "x",
        display_name: "X",
        avatar_emoji: "🤷",
      },
    ]);
    fake.results.push([{ count: 2 }]);

    const res = await callGet("?channel_id=c1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      channel: string;
      posts: Array<{ id: string; broken: boolean }>;
      total: number;
    };
    expect(body.channel).toBe("AI News");
    expect(body.total).toBe(2);
    expect(body.posts).toHaveLength(2);
    expect(body.posts.find((p) => p.id === "p-broken")!.broken).toBe(true);
    expect(body.posts.find((p) => p.id === "p-1")!.broken).toBe(false);
  });

  it("respects limit + offset params (capped at 100)", async () => {
    fake.results.push([{ id: "c1", name: "X", slug: "x" }]);
    fake.results.push([]);
    fake.results.push([{ count: 0 }]);
    const res = await callGet("?channel_id=c1&limit=999&offset=50");
    const body = (await res.json()) as { limit: number; offset: number };
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(50);
  });
});

describe("DELETE /api/admin/channels/flush", () => {
  it("401 when not admin", async () => {
    expect((await callDelete({ post_ids: ["a"] }, false)).status).toBe(401);
  });

  it("400 when post_ids missing/empty", async () => {
    expect((await callDelete({})).status).toBe(400);
    expect((await callDelete({ post_ids: [] })).status).toBe(400);
  });

  it("default untag runs UPDATE SET channel_id = NULL", async () => {
    fake.results.push([]);
    const res = await callDelete({ post_ids: ["p-1", "p-2"] });
    const body = (await res.json()) as { action: string; count: number };
    expect(body.action).toBe("untagged");
    expect(body.count).toBe(2);
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE posts SET channel_id = NULL"),
    );
    expect(update).toBeDefined();
  });

  it("delete_post:true runs DELETE FROM posts", async () => {
    fake.results.push([]);
    const res = await callDelete({
      post_ids: ["p-1"],
      delete_post: true,
    });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("deleted");
    const del = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM posts"),
    );
    expect(del).toBeDefined();
  });
});

describe("POST /api/admin/channels/flush", () => {
  it("401 when not admin", async () => {
    expect((await callPost({ channel_id: "c" }, false)).status).toBe(401);
  });

  it("400 when channel_id missing", async () => {
    expect((await callPost({})).status).toBe(400);
  });

  it("404 when channel not found", async () => {
    fake.results.push([]);
    expect((await callPost({ channel_id: "missing" })).status).toBe(404);
  });

  it("empty channel → early return", async () => {
    fake.results.push([
      {
        id: "c",
        name: "X",
        slug: "x",
        genre: "drama",
        content_rules: {},
        description: "",
      },
    ]);
    fake.results.push([]); // no posts
    const res = await callPost({ channel_id: "c" });
    const body = (await res.json()) as { flushed: number; message: string };
    expect(body.flushed).toBe(0);
    expect(body.message).toContain("No posts");
    expect(gen.calls).toHaveLength(0);
  });

  it("AI-flagged irrelevant posts get untagged", async () => {
    fake.results.push([
      {
        id: "c",
        name: "GNN",
        slug: "gnn",
        genre: "news",
        content_rules: { tone: "serious" },
        description: "AI news",
      },
    ]);
    fake.results.push([
      {
        id: "p-1",
        content: "breaking story",
        media_type: "video",
        media_url: "https://b.test/v.mp4",
      },
      {
        id: "p-2",
        content: "my cat is cute",
        media_type: "image",
        media_url: "https://b.test/c.jpg",
      },
    ]);
    // AI flags post 2 as irrelevant
    gen.queue.push(
      JSON.stringify([{ idx: 2, relevant: false, reason: "off topic" }]),
    );
    fake.results.push([]); // UPDATE
    const res = await callPost({ channel_id: "c" });
    const body = (await res.json()) as {
      total_posts: number;
      irrelevant: number;
      flushed: number;
      irrelevant_ids: string[];
    };
    expect(body.total_posts).toBe(2);
    expect(body.flushed).toBe(1);
    expect(body.irrelevant_ids).toContain("p-2");
    expect(body.irrelevant_ids).not.toContain("p-1");
  });

  it("broken video posts auto-flagged even when AI says relevant", async () => {
    fake.results.push([
      {
        id: "c",
        name: "X",
        slug: "x",
        genre: "drama",
        content_rules: {},
        description: "",
      },
    ]);
    fake.results.push([
      {
        id: "p-broken",
        content: "text",
        media_type: "video",
        media_url: null,
      },
      {
        id: "p-ok",
        content: "text",
        media_type: "image",
        media_url: "https://b.test/ok.jpg",
      },
    ]);
    gen.queue.push("[]"); // AI says all relevant
    fake.results.push([]); // UPDATE
    const res = await callPost({ channel_id: "c" });
    const body = (await res.json()) as { irrelevant_ids: string[] };
    expect(body.irrelevant_ids).toContain("p-broken");
  });

  it("dry_run skips UPDATE and reports flushed=0 but keeps irrelevant list", async () => {
    fake.results.push([
      {
        id: "c",
        name: "X",
        slug: "x",
        genre: "drama",
        content_rules: {},
        description: "",
      },
    ]);
    fake.results.push([
      {
        id: "p-1",
        content: "offtopic cats",
        media_type: "image",
        media_url: "https://b.test/c.jpg",
      },
    ]);
    gen.queue.push(JSON.stringify([{ idx: 1, relevant: false }]));
    const res = await callPost({ channel_id: "c", dry_run: true });
    const body = (await res.json()) as {
      flushed: number;
      dry_run: boolean;
      irrelevant_ids: string[];
    };
    expect(body.flushed).toBe(0);
    expect(body.dry_run).toBe(true);
    expect(body.irrelevant_ids).toContain("p-1");
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE posts SET channel_id = NULL"),
    );
    expect(update).toBeUndefined();
  });

  it("AI returns non-array → nothing flagged (parse failure short-circuit)", async () => {
    fake.results.push([
      {
        id: "c",
        name: "X",
        slug: "x",
        genre: "drama",
        content_rules: {},
        description: "",
      },
    ]);
    fake.results.push([
      {
        id: "p-1",
        content: "something",
        media_type: "image",
        media_url: "https://b.test/ok.jpg",
      },
    ]);
    gen.queue.push("sorry, I cannot help with that");
    fake.results.push([]); // UPDATE attempted (empty irrelevant set → no rows)

    const res = await callPost({ channel_id: "c" });
    const body = (await res.json()) as { irrelevant: number; flushed: number };
    expect(body.irrelevant).toBe(0);
    expect(body.flushed).toBe(0);
  });

  it("content_rules stored as string gets JSON-parsed", async () => {
    fake.results.push([
      {
        id: "c",
        name: "X",
        slug: "x",
        genre: "drama",
        content_rules: JSON.stringify({ topics: ["drama"] }),
        description: "",
      },
    ]);
    fake.results.push([
      {
        id: "p-1",
        content: "ok",
        media_type: "image",
        media_url: "https://b.test/x.jpg",
      },
    ]);
    gen.queue.push("[]");
    fake.results.push([]); // UPDATE
    const res = await callPost({ channel_id: "c" });
    expect(res.status).toBe(200);
    // Verify prompt was called with the parsed rules
    const prompt = (gen.calls[0] as { userPrompt: string }).userPrompt;
    expect(prompt).toContain("drama");
  });
});
