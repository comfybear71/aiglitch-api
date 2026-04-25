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
const YT_ACCOUNT = { ...X_ACCOUNT, id: "acc-yt", platform: "youtube" };

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  getActiveAccountsMock.mockReset();
  postToPlatformMock.mockReset();
  adaptContentMock.mockReset();
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
    new NextRequest("http://localhost/api/admin/media/spread", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/admin/media/spread — auth", () => {
  it("401 when not authed as admin", async () => {
    const res = await callPOST({});
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/media/spread — happy paths", () => {
  it("400 when no active accounts configured", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([]);
    fake.results = [
      [], // ensure marketing_posts
      [], // ensure marketing_platform_accounts
    ];
    const res = await callPOST({});
    expect(res.status).toBe(400);
  });

  it("returns spread:0 when nothing to spread", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    fake.results = [
      [], // ensure marketing_posts
      [], // ensure marketing_platform_accounts
      [], // SELECT architect posts → empty
    ];
    const res = await callPOST({});
    const body = (await res.json()) as { spread: number };
    expect(body.spread).toBe(0);
  });

  it("spreads a specific post id list with platform filter", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT, YT_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({
      success: true,
      platformPostId: "tw-1",
      platformUrl: "https://x.com/tw-1",
    });
    fake.results = [
      [], // ensure marketing_posts
      [], // ensure marketing_platform_accounts
      [
        {
          id: "post-1",
          content: "test",
          media_url: "https://cdn/img.jpg",
          media_type: "image",
        },
      ],
      [], // INSERT marketing_posts (X)
      [], // UPDATE marketing_posts → posted (X)
    ];

    const res = await callPOST({ post_ids: ["post-1"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      posted: number;
      failed: number;
      details: { platform: string; status: string }[];
    };
    expect(body.posted).toBe(1); // YouTube skipped because non-video
    expect(body.details.find((d) => d.platform === "youtube")).toBeUndefined();
    expect(body.details[0]!.platform).toBe("x");
  });

  it("flags platform failures in details + counts them", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({
      success: false,
      error: "rate limited",
    });
    fake.results = [
      [], // ensure tables
      [],
      [
        {
          id: "p-1",
          content: "x",
          media_url: "https://cdn/v.mp4",
          media_type: "video",
        },
      ],
      [], // INSERT
      [], // UPDATE → failed
    ];

    const res = await callPOST({});
    const body = (await res.json()) as { failed: number; details: { error?: string }[] };
    expect(body.failed).toBe(1);
    expect(body.details[0]!.error).toContain("rate limited");
  });

  it("youtube IS spread when post is video", async () => {
    mockIsAdmin = true;
    getActiveAccountsMock.mockResolvedValue([YT_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });
    fake.results = [
      [], // ensure
      [],
      [
        {
          id: "p-1",
          content: "video post",
          media_url: "https://cdn/v.mp4",
          media_type: "video",
        },
      ],
      [], // insert
      [], // update
    ];

    const res = await callPOST({});
    const body = (await res.json()) as { posted: number };
    expect(body.posted).toBe(1);
    expect(adaptContentMock).toHaveBeenCalledWith(
      "video post",
      "🙏 The Architect",
      "🕉️",
      "youtube",
      "https://cdn/v.mp4",
    );
  });
});
