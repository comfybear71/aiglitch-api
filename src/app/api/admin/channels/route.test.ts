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

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  options: { query?: string; body?: unknown; authed?: boolean } = {},
) {
  if (options.authed !== false) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (options.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(options.body);
  }
  const url = `http://localhost/api/admin/channels${options.query ?? ""}`;
  const req = new NextRequest(url, init);
  const handler = { GET: mod.GET, POST: mod.POST, PATCH: mod.PATCH, DELETE: mod.DELETE }[method];
  return handler(req);
}

describe("GET", () => {
  it("401 when not admin", async () => {
    expect((await call("GET", { authed: false })).status).toBe(401);
  });

  it("lost_videos action returns list", async () => {
    fake.results.push([]); // ALTER TABLE
    fake.results.push([{ id: "p-1", content: "orphan video" }]);
    const res = await call("GET", { query: "?action=lost_videos" });
    const body = (await res.json()) as { lost: { id: string }[] };
    expect(body.lost).toHaveLength(1);
  });

  it("default GET returns channels with personas + defaults applied", async () => {
    fake.results.push([]); // ALTER TABLE
    fake.results.push([
      {
        id: "ch-1",
        slug: "test",
        name: "Test",
        content_rules: '{"tone":"serious"}',
        schedule: null,
      },
    ]);
    fake.results.push([
      {
        channel_id: "ch-1",
        persona_id: "p-1",
        role: "host",
        username: "u",
        display_name: "D",
        avatar_emoji: "✨",
      },
    ]);
    const res = await call("GET");
    const body = (await res.json()) as {
      channels: Array<{
        id: string;
        content_rules: unknown;
        scene_duration: number;
        personas: unknown[];
      }>;
    };
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]!.content_rules).toEqual({ tone: "serious" });
    expect(body.channels[0]!.scene_duration).toBe(10);
    expect(body.channels[0]!.personas).toHaveLength(1);
  });
});

describe("POST", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { authed: false, body: {} })).status).toBe(401);
  });

  it("400 when slug or name missing", async () => {
    expect((await call("POST", { body: { slug: "x" } })).status).toBe(400);
    expect((await call("POST", { body: { name: "x" } })).status).toBe(400);
  });

  it("upsert + persona assignments", async () => {
    fake.results.push([]); // ALTER TABLE
    fake.results.push([]); // INSERT ON CONFLICT
    fake.results.push([]); // DELETE channel_personas
    fake.results.push([]); // INSERT channel_personas (persona 1)
    const res = await call("POST", {
      body: {
        slug: "ai-news",
        name: "AI News",
        persona_ids: ["p-1"],
        host_ids: ["p-1"],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channelId: string };
    expect(body.ok).toBe(true);
    expect(body.channelId).toBe("ch-ai-news");
    const hostInsert = fake.calls.find(
      (c) =>
        c.strings.join("?").includes("INSERT INTO channel_personas") &&
        c.values.includes("host"),
    );
    expect(hostInsert).toBeDefined();
  });
});

describe("PATCH actions", () => {
  it("401 when not admin", async () => {
    expect((await call("PATCH", { authed: false, body: {} })).status).toBe(401);
  });

  it("default path requires post_ids", async () => {
    expect((await call("PATCH", { body: {} })).status).toBe(400);
  });

  it("move_all_to_lost requires channel_id", async () => {
    expect(
      (await call("PATCH", { body: { action: "move_all_to_lost" } })).status,
    ).toBe(400);
  });

  it("move_all_to_lost happy path", async () => {
    fake.results.push([{ id: "p-1" }, { id: "p-2" }]); // UPDATE RETURNING
    fake.results.push([]); // UPDATE channels post_count
    const res = await call("PATCH", {
      body: { action: "move_all_to_lost", channel_id: "ch-x" },
    });
    const body = (await res.json()) as { moved: number };
    expect(body.moved).toBe(2);
  });

  it("move posts to target channel — renames prefix", async () => {
    fake.results.push([{ id: "p-1", channel_id: "ch-old" }]); // posts lookup
    fake.results.push([{ id: "ch-gnn", name: "GNN" }]); // target lookup
    fake.results.push([{ content: "some old content" }]); // post content
    fake.results.push([]); // UPDATE post
    fake.results.push([]); // UPDATE target channel count
    fake.results.push([]); // UPDATE source channel count
    const res = await call("PATCH", {
      body: { post_ids: ["p-1"], target_channel_id: "ch-gnn" },
    });
    const body = (await res.json()) as { moved: number; target: string };
    expect(body.moved).toBe(1);
    expect(body.target).toBe("ch-gnn");
    // Verify a "🎬 GNN - " prefix was applied
    const updatePost = fake.calls.find(
      (c) =>
        c.strings.join("?").includes("UPDATE posts SET content") &&
        (c.values[0] as string).startsWith("🎬 GNN - "),
    );
    expect(updatePost).toBeDefined();
  });

  it("target_channel_id with missing channel → 404", async () => {
    fake.results.push([{ id: "p-1", channel_id: null }]); // posts lookup
    fake.results.push([]); // target lookup empty
    const res = await call("PATCH", {
      body: { post_ids: ["p-1"], target_channel_id: "missing" },
    });
    expect(res.status).toBe(404);
  });

  it("flush_non_video happy path", async () => {
    fake.results.push([{ id: "p-1" }, { id: "p-2" }, { id: "p-3" }]);
    fake.results.push([]); // UPDATE channels counts
    const res = await call("PATCH", { body: { action: "flush_non_video" } });
    const body = (await res.json()) as { flushed: number };
    expect(body.flushed).toBe(3);
  });

  it("restore_by_prefix requires channel_id + prefix", async () => {
    expect(
      (await call("PATCH", { body: { action: "restore_by_prefix" } })).status,
    ).toBe(400);
  });

  it("flush_off_brand happy path", async () => {
    fake.results.push([{ id: "p-1" }]); // UPDATE RETURNING
    fake.results.push([]); // UPDATE channels count
    const res = await call("PATCH", {
      body: {
        action: "flush_off_brand",
        channel_id: "ch-gnn",
        prefix: "GNN",
      },
    });
    const body = (await res.json()) as { flushed: number };
    expect(body.flushed).toBe(1);
  });
});

describe("DELETE", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", { authed: false, body: { id: "x" } })).status).toBe(
      401,
    );
  });

  it("400 when id missing", async () => {
    expect((await call("DELETE", { body: {} })).status).toBe(400);
  });

  it("happy path fires 4 cascading DELETEs", async () => {
    fake.results.push([]); // DELETE channel_personas
    fake.results.push([]); // DELETE channel_subscriptions
    fake.results.push([]); // UPDATE posts SET channel_id = NULL
    fake.results.push([]); // DELETE channels
    const res = await call("DELETE", { body: { id: "ch-x" } });
    expect(res.status).toBe(200);
    expect(
      fake.calls.filter((c) => c.strings.join("?").includes("DELETE FROM")).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
