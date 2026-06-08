/**
 * Tests for /api/meatlab — public POST/GET/PATCH.
 *
 * The bug that birthed v1.45.0: a Chrome-on-Android user reported
 * "Failed to execute 'json' on 'Response': Unexpected end of JSON
 * input" after a successful Blob upload. Diagnosis: POST + PATCH
 * never existed on this repo, the strangler proxied them here, and
 * Next.js's default 405 returns an empty body. Tests below pin
 * every method down so the next regression is loud.
 */

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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

// ensureMeatLabTables fires 9 CREATE/ALTER statements at the top of
// every entry point. Stuff that many empty results in front so the
// real query lands on the result the test cares about.
function withEnsure(...rows: (RowSet | Error)[]): (RowSet | Error)[] {
  return [...Array(9).fill([]), ...rows];
}

async function call(
  method: "GET" | "POST" | "PATCH",
  opts: { query?: string; body?: unknown } = {},
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/meatlab${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  if (method === "GET") return mod.GET(req);
  if (method === "POST") return mod.POST(req);
  return mod.PATCH(req);
}

// ── POST ─────────────────────────────────────────────────────────────

describe("POST /api/meatlab", () => {
  it("401 when session_id missing", async () => {
    fake.results = withEnsure();
    const res = await call("POST", {
      body: { media_url: "https://blob.test/x.mp4" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("session_id");
  });

  it("400 when media_url missing", async () => {
    fake.results = withEnsure();
    const res = await call("POST", { body: { session_id: "s1" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("media_url");
  });

  it("401 when session does not match a human_users row", async () => {
    fake.results = withEnsure(
      [], // SELECT human_users by session_id → none
    );
    const res = await call("POST", {
      body: { session_id: "ghost", media_url: "https://blob.test/x.mp4" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid session");
  });

  it("creates pending row + returns id on happy path (video inferred from .mp4)", async () => {
    fake.results = withEnsure(
      [{ id: "u-1", display_name: "Meat Bag", username: "mb" }], // SELECT user
      [], // INSERT
    );
    const res = await call("POST", {
      body: {
        session_id: "s1",
        media_url: "https://blob.test/meatlab/clip.mp4",
        title: "kokushibo vs yoriichi",
        description: "seedance 2.0",
        ai_tool: "seedance",
        tags: "Zanart",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      id: string;
      status: string;
    };
    expect(body.success).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    // Verify the INSERT received media_type=video (last sql call before response)
    const insertCall = fake.calls.at(-1)!;
    expect(insertCall.values).toContain("video");
  });

  it("infers media_type=image when URL lacks a known video extension", async () => {
    fake.results = withEnsure(
      [{ id: "u-1", display_name: "Meat Bag", username: "mb" }],
      [],
    );
    await call("POST", {
      body: {
        session_id: "s1",
        media_url: "https://blob.test/meatlab/art.png",
      },
    });
    const insertCall = fake.calls.at(-1)!;
    expect(insertCall.values).toContain("image");
  });

  it("explicit media_type=video overrides URL inference", async () => {
    fake.results = withEnsure(
      [{ id: "u-1", display_name: "Meat Bag", username: "mb" }],
      [],
    );
    await call("POST", {
      body: {
        session_id: "s1",
        media_url: "https://blob.test/meatlab/no-ext-file",
        media_type: "video",
      },
    });
    const insertCall = fake.calls.at(-1)!;
    expect(insertCall.values).toContain("video");
  });

  it("500 with non-empty JSON body when INSERT fails (no empty-body regression)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.results = withEnsure(
      [{ id: "u-1", display_name: "Meat Bag", username: "mb" }],
      new Error("constraint violation"),
    );
    const res = await call("POST", {
      body: {
        session_id: "s1",
        media_url: "https://blob.test/x.mp4",
      },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to save submission");
    errSpy.mockRestore();
  });
});

// ── GET ─────────────────────────────────────────────────────────────

describe("GET /api/meatlab", () => {
  it("?approved=1 lists approved submissions joined with creator", async () => {
    fake.results = withEnsure(
      [
        {
          id: "m-1",
          title: "test",
          media_url: "u",
          creator_name: "Meat Bag",
          creator_username: "mb",
        },
      ],
    );
    const res = await call("GET", { query: "?approved=1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      posts: Array<{ creator_name: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.posts[0]!.creator_name).toBe("Meat Bag");
  });

  it("?session_id lists caller's own submissions across statuses", async () => {
    fake.results = withEnsure([{ id: "m-1", status: "pending" }]);
    const res = await call("GET", { query: "?session_id=s1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it("requires session_id when neither ?approved nor ?creator supplied", async () => {
    fake.results = withEnsure();
    const res = await call("GET");
    expect(res.status).toBe(401);
  });

  it("?creator=<slug> → 404 when no human_users row matches", async () => {
    fake.results = withEnsure(
      [], // SELECT human_users → none
    );
    const res = await call("GET", { query: "?creator=nope" });
    expect(res.status).toBe(404);
  });

  it("?creator returns profile + posts + stats", async () => {
    fake.results = withEnsure(
      [
        {
          id: "u-1",
          display_name: "Meat Bag",
          username: "mb",
          avatar_emoji: "🥩",
          avatar_url: null,
          bio: "",
          x_handle: null,
          instagram_handle: null,
          tiktok_handle: null,
          youtube_handle: null,
          website_url: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ], // SELECT human_users
      [{ id: "m-1", title: "approved post" }], // SELECT meatlab_submissions
      [], // ALTER posts add meatbag_author_id
      [
        {
          total_uploads: 2,
          total_likes: 10,
          total_comments: 3,
          total_views: 50,
        },
      ], // engagement stats
      [], // feed posts
    );
    const res = await call("GET", { query: "?creator=mb" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      creator: { username: string };
      stats: { total_uploads: number };
      posts: unknown[];
    };
    expect(body.creator.username).toBe("mb");
    expect(body.stats.total_uploads).toBe(2);
    expect(body.posts.length).toBe(1);
  });
});

// ── PATCH ───────────────────────────────────────────────────────────

describe("PATCH /api/meatlab", () => {
  it("401 when session_id missing", async () => {
    fake.results = withEnsure();
    const res = await call("PATCH", { body: { x_handle: "@me" } });
    expect(res.status).toBe(401);
  });

  it("updates social handles when session_id present", async () => {
    fake.results = withEnsure([]); // UPDATE
    const res = await call("PATCH", {
      body: {
        session_id: "s1",
        x_handle: "@me",
        instagram_handle: "@me_ig",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    const updateCall = fake.calls.at(-1)!;
    expect(updateCall.values).toContain("@me");
    expect(updateCall.values).toContain("@me_ig");
  });

  it("500 with JSON error when UPDATE throws", async () => {
    fake.results = withEnsure(new Error("db down"));
    const res = await call("PATCH", {
      body: { session_id: "s1", x_handle: "@me" },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("db down");
  });
});
