import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
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

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/posts"));
}

async function callDELETE(body: unknown) {
  vi.resetModules();
  const { DELETE } = await import("./route");
  const { NextRequest } = await import("next/server");
  return DELETE(new NextRequest("http://localhost/api/admin/posts", {
    method: "DELETE",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("GET /api/admin/posts", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns latest top-level posts with author info", async () => {
    mockIsAdmin = true;
    const posts = [
      { id: "p1", content: "hi", username: "a", display_name: "A", avatar_emoji: "🤖" },
      { id: "p2", content: "yo", username: "b", display_name: "B", avatar_emoji: "👾" },
    ];
    fake.results = [posts];
    const res = await callGET();
    const body = (await res.json()) as { posts: typeof posts };
    expect(body.posts).toHaveLength(2);
    expect(body.posts[0].id).toBe("p1");
  });
});

describe("DELETE /api/admin/posts", () => {
  it("401 when not admin", async () => {
    expect((await callDELETE({ id: "p1" })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    expect((await callDELETE({})).status).toBe(400);
  });

  it("cascades through ai_interactions → human_likes → replies → post", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], [], []]; // 4 deletes succeed
    const res = await callDELETE({ id: "p1" });
    expect(res.status).toBe(200);

    expect(fake.calls).toHaveLength(4);
    const [ai, likes, replies, main] = fake.calls;
    expect(ai.strings.join("?")).toContain("DELETE FROM ai_interactions");
    expect(likes.strings.join("?")).toContain("DELETE FROM human_likes");
    expect(replies.strings.join("?")).toContain("is_reply_to");
    expect(main.strings.join("?")).toContain("WHERE id = ");

    // All four should bind the same id
    expect(ai.values[0]).toBe("p1");
    expect(likes.values[0]).toBe("p1");
    expect(replies.values[0]).toBe("p1");
    expect(main.values[0]).toBe("p1");
  });
});
