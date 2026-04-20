import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

function makeFetch(responses: { ok: boolean; body: unknown; status?: number }[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift() ?? { ok: true, body: {} };
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  });
}

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.X_CONSUMER_KEY;
  delete process.env.X_CONSUMER_SECRET;
  delete process.env.X_ACCESS_TOKEN;
  delete process.env.X_ACCESS_TOKEN_SECRET;
  delete process.env.FACEBOOK_ACCESS_TOKEN;
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_USER_ID;
  vi.restoreAllMocks();
});

async function loadAndRun() {
  const { collectAllMetrics } = await import("./metrics-collector");
  return collectAllMetrics();
}

const X_POST = {
  id: "mp-1",
  campaign_id: null,
  platform: "x",
  source_post_id: null,
  persona_id: null,
  adapted_content: "test",
  adapted_media_url: null,
  thumbnail_url: null,
  platform_post_id: "tw-123",
  platform_url: null,
  status: "posted",
  scheduled_for: null,
  posted_at: "2026-04-20T00:00:00Z",
  impressions: 0,
  likes: 0,
  shares: 0,
  comments: 0,
  views: 0,
  clicks: 0,
  error_message: null,
  created_at: "2026-04-20T00:00:00Z",
};

describe("collectAllMetrics", () => {
  it("returns zeros when no posted marketing_posts", async () => {
    fake.results = [[]]; // SELECT posts → empty
    const result = await loadAndRun();
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.details).toEqual([]);
  });

  it("skips platform when no active account exists", async () => {
    fake.results = [
      [X_POST],  // SELECT posts
      [],        // SELECT account for x — empty, no env creds
      [],        // rollup aggregates — empty
    ];
    const result = await loadAndRun();
    expect(result.updated).toBe(0);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toMatchObject({
      platform: "x",
      postId: "mp-1",
      status: "skipped",
    });
  });

  it("updates metrics when X API returns public_metrics", async () => {
    // X uses OAuth from env — set creds so getAppCredentials doesn't throw
    process.env.X_CONSUMER_KEY = "ck";
    process.env.X_CONSUMER_SECRET = "cs";
    process.env.X_ACCESS_TOKEN = "at";
    process.env.X_ACCESS_TOKEN_SECRET = "ats";

    vi.stubGlobal("fetch", makeFetch([{
      ok: true,
      body: {
        data: {
          public_metrics: {
            like_count: 10,
            retweet_count: 2,
            quote_count: 1,
            reply_count: 5,
            impression_count: 500,
          },
        },
      },
    }]));

    fake.results = [
      [X_POST],                                               // SELECT posts
      [{ platform: "x", access_token: "unused", is_active: true, id: "a-1" }], // SELECT account
      [],                                                     // UPDATE marketing_posts
      [],                                                     // SELECT aggregates (empty)
    ];

    const result = await loadAndRun();
    expect(result.updated).toBe(1);
    expect(result.details[0]).toMatchObject({ platform: "x", postId: "mp-1", status: "updated" });
  });

  it("marks post as no_data when API returns empty metrics", async () => {
    process.env.X_CONSUMER_KEY = "ck";
    process.env.X_CONSUMER_SECRET = "cs";
    process.env.X_ACCESS_TOKEN = "at";
    process.env.X_ACCESS_TOKEN_SECRET = "ats";

    vi.stubGlobal("fetch", makeFetch([{ ok: true, body: { data: null } }]));

    fake.results = [
      [X_POST],
      [{ platform: "x", access_token: "x", is_active: true, id: "a-1" }],
      [],
    ];

    const result = await loadAndRun();
    expect(result.updated).toBe(0);
    expect(result.details[0].status).toBe("no_data");
  });
});
