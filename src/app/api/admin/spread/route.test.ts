import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake: { calls: SqlCall[]; results: RowSet[] } = { calls: [], results: [] };

function fakeSql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const adaptContentMock = vi.fn();
vi.mock("@/lib/marketing/content-adapter", () => ({
  adaptContentForPlatform: (...args: unknown[]) => adaptContentMock(...args),
}));

const getActiveAccountsMock = vi.fn();
const postToPlatformMock = vi.fn();
vi.mock("@/lib/marketing/platforms", () => ({
  getActiveAccounts: (...args: unknown[]) => getActiveAccountsMock(...args),
  postToPlatform: (...args: unknown[]) => postToPlatformMock(...args),
}));

const pickFallbackMediaMock = vi.fn();
vi.mock("@/lib/marketing/spread-post", () => ({
  pickFallbackMedia: (...args: unknown[]) => pickFallbackMediaMock(...args),
}));

const X_ACCOUNT = {
  id: "acc-x",
  platform: "x",
  account_name: "aiglitch",
  account_id: "1",
  account_url: "",
  access_token: "",
  refresh_token: "",
  token_expires_at: null,
  extra_config: "{}",
  is_active: true,
  last_posted_at: null,
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
};

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  getActiveAccountsMock.mockReset();
  postToPlatformMock.mockReset();
  adaptContentMock.mockReset();
  pickFallbackMediaMock.mockReset();
  pickFallbackMediaMock.mockResolvedValue(null);
  adaptContentMock.mockResolvedValue({
    text: "adapted",
    hashtags: [],
    callToAction: "x",
    thumbnailPrompt: "x",
  });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { __resetMarketingTablesFlag } = await import("@/lib/marketing/ensure-tables");
  __resetMarketingTablesFlag();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/admin/spread", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

async function callGET() {
  vi.resetModules();
  const { __resetMarketingTablesFlag } = await import("@/lib/marketing/ensure-tables");
  __resetMarketingTablesFlag();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(
    new NextRequest("http://localhost/api/admin/spread", {
      method: "GET",
    }),
  );
}

describe("POST /api/admin/spread — auth + validation", () => {
  it("401 when not authed", async () => {
    const res = await callPOST({});
    expect(res.status).toBe(401);
  });

  it("400 when no active accounts", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([]);
    fake.results = [[], []]; // ensure tables
    const res = await callPOST({ post_id: "p-1" });
    expect(res.status).toBe(400);
  });

  it("400 when no post_id, post_ids, or text given", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    fake.results = [[], []];
    const res = await callPOST({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Provide");
  });

  it("404 when post_ids reference no rows", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    fake.results = [
      [], // ensure
      [],
      [], // UPDATE channel-tag (skipped because no channel)
      [], // SELECT join → empty
    ];
    const res = await callPOST({ post_ids: ["nope"] });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/spread — text mode", () => {
  it("creates a new feed post under The Architect and spreads it", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({
      success: true,
      platformPostId: "tw-1",
    });
    fake.results = [
      [], // ensure marketing_posts
      [], // ensure marketing_platform_accounts
      [], // INSERT posts
      [], // UPDATE persona post_count
      [], // INSERT marketing_posts (X)
      [], // UPDATE marketing_posts → posted
    ];

    const res = await callPOST({ text: "hello world" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posted: number };
    expect(body.posted).toBe(1);
    expect(adaptContentMock).toHaveBeenCalledWith(
      "hello world",
      "AIG!itch",
      "🤖",
      "x",
      null,
    );
  });

  it("text mode with channel_id increments channel post_count", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });
    fake.results = [
      [], // ensure
      [],
      [], // INSERT posts
      [], // UPDATE persona
      [], // UPDATE channels.post_count
      [], // INSERT marketing_posts
      [], // UPDATE marketing_posts → posted
    ];

    await callPOST({ text: "x", channel_id: "ch-1" });

    const channelUpdate = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE channels"),
    );
    expect(channelUpdate).toBeTruthy();
  });

  it("falls back to pickFallbackMedia when text post has no media", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });
    pickFallbackMediaMock.mockResolvedValue("https://cdn/fallback.jpg");
    fake.results = [
      [], // ensure
      [],
      [], // INSERT posts
      [], // UPDATE persona
      [], // INSERT marketing_posts
      [], // UPDATE marketing_posts
    ];

    await callPOST({ text: "no media" });
    expect(pickFallbackMediaMock).toHaveBeenCalled();
    const adaptCall = adaptContentMock.mock.calls[0];
    expect(adaptCall[4]).toBe("https://cdn/fallback.jpg");
  });
});

describe("POST /api/admin/spread — post-id mode", () => {
  it("spreads multiple posts joined with persona display names", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });
    fake.results = [
      [], // ensure
      [],
      [
        {
          id: "p-1",
          content: "first",
          media_url: "https://cdn/a.png",
          media_type: "image",
          persona_name: "Grok",
          persona_emoji: "🔥",
        },
        {
          id: "p-2",
          content: "second",
          media_url: "https://cdn/b.png",
          media_type: "image",
          persona_name: "Claude",
          persona_emoji: "🤖",
        },
      ],
      [], // INSERT marketing_posts (p-1, x)
      [], // UPDATE → posted (p-1, x)
      [], // INSERT marketing_posts (p-2, x)
      [], // UPDATE → posted (p-2, x)
    ];

    const res = await callPOST({ post_ids: ["p-1", "p-2"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posted: number; posts_found: number };
    expect(body.posts_found).toBe(2);
    expect(body.posted).toBe(2);
    expect(adaptContentMock.mock.calls[0]![1]).toBe("Grok");
    expect(adaptContentMock.mock.calls[1]![1]).toBe("Claude");
  });
});

describe("GET /api/admin/spread", () => {
  it("401 when not authed", async () => {
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("returns accounts + recent spreads + stats", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    fake.results = [
      [], // ensure marketing_posts
      [], // ensure marketing_platform_accounts
      [
        {
          id: "mp-1",
          platform: "x",
          source_post_id: "p-1",
          adapted_content: "adapted",
          adapted_media_url: null,
          status: "posted",
          platform_url: "https://x.com/...",
          posted_at: "2026-04-23T00:00:00Z",
          error_message: null,
        },
      ],
      [{ total: "10", posted: "7", failed: "3" }],
    ];

    const res = await callGET();
    const body = (await res.json()) as {
      accounts: { platform: string }[];
      recent_spreads: unknown[];
      stats: { total: number; posted: number; failed: number };
    };
    expect(body.accounts).toEqual([{ platform: "x", name: "aiglitch" }]);
    expect(body.recent_spreads.length).toBe(1);
    expect(body.stats).toEqual({ total: 10, posted: 7, failed: 3 });
  });
});
