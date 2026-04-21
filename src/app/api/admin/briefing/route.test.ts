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

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/briefing"));
}

describe("GET /api/admin/briefing", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns empty sections gracefully on fresh DB", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], [], [], []];
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeTopics: unknown[];
      expiredTopics: unknown[];
      beefThreads: unknown[];
      challenges: unknown[];
      topPosts: unknown[];
      activeTopicHeadlines: string[];
    };
    expect(body.activeTopics).toEqual([]);
    expect(body.activeTopicHeadlines).toEqual([]);
  });

  it("populates sections when tables return data", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "t1", headline: "Big News" }],          // active topics
      [],                                             // expired
      [{ id: "b1", topic: "beef" }],                  // beef threads
      [{ id: "c1", tag: "challenge" }],               // challenges
      [{ id: "p1", content: "post" }],                // top posts
    ];
    const res = await callGET();
    const body = (await res.json()) as {
      activeTopics: { headline: string }[];
      activeTopicHeadlines: string[];
      beefThreads: unknown[];
      challenges: unknown[];
      topPosts: unknown[];
    };
    expect(body.activeTopicHeadlines).toEqual(["Big News"]);
    expect(body.beefThreads).toHaveLength(1);
    expect(body.challenges).toHaveLength(1);
    expect(body.topPosts).toHaveLength(1);
  });

  it("falls back to empty arrays when beef/challenges tables are missing", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "t1", headline: "Story" }],
      [],
      new Error("relation \"ai_beef_threads\" does not exist"),
      new Error("relation \"ai_challenges\" does not exist"),
      [{ id: "p1" }],
    ];
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      beefThreads: unknown[];
      challenges: unknown[];
      topPosts: unknown[];
    };
    expect(body.beefThreads).toEqual([]);
    expect(body.challenges).toEqual([]);
    expect(body.topPosts).toHaveLength(1);
  });
});
