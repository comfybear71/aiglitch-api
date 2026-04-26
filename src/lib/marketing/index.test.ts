import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const adaptContentMock = vi.fn();
const pickTopPostsMock = vi.fn();
vi.mock("./content-adapter", () => ({
  adaptContentForPlatform: (...a: unknown[]) => adaptContentMock(...a),
  pickTopPosts: (...a: unknown[]) => pickTopPostsMock(...a),
}));

const getActiveAccountsMock = vi.fn();
const postToPlatformMock = vi.fn();
vi.mock("./platforms", () => ({
  getActiveAccounts: (...a: unknown[]) => getActiveAccountsMock(...a),
  postToPlatform: (...a: unknown[]) => postToPlatformMock(...a),
  getAccountForPlatform: vi.fn(),
}));

vi.mock("./spread-post", () => ({
  pickFallbackMedia: () => Promise.resolve(null),
}));

const X_ACCOUNT = {
  id: "acc-x",
  platform: "x",
  account_name: "x",
  account_id: "1",
  account_url: "",
  access_token: "",
  refresh_token: "",
  token_expires_at: null,
  extra_config: "{}",
  is_active: true,
  last_posted_at: null,
  created_at: "x",
  updated_at: "x",
};
const SAMPLE_POST = {
  id: "p-1",
  content: "test",
  persona_id: "px",
  display_name: "Persona X",
  avatar_emoji: "🚀",
  username: "px",
  media_url: "https://cdn/x.jpg",
  media_type: "image",
  engagement_score: 50,
};

beforeEach(() => {
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  adaptContentMock.mockReset();
  pickTopPostsMock.mockReset();
  getActiveAccountsMock.mockReset();
  postToPlatformMock.mockReset();
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

describe("runMarketingCycle", () => {
  it("queues posts for showcase when no accounts are configured", async () => {
    getActiveAccountsMock.mockResolvedValue([]);
    pickTopPostsMock.mockResolvedValue([SAMPLE_POST]);
    fake.results = [
      [], [], // ensure tables
      [], [], [], [], // 4× INSERT marketing_posts (one per ALL_PLATFORM)
    ];

    const { __resetMarketingTablesFlag } = await import("./ensure-tables");
    __resetMarketingTablesFlag();
    const { runMarketingCycle } = await import("./index");
    const result = await runMarketingCycle();

    expect(result.posted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(4); // 1 post × 4 platforms
    expect(result.details[0]!.status).toBe("queued");
  });

  it("posts to active accounts and tracks success", async () => {
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    pickTopPostsMock.mockResolvedValue([SAMPLE_POST]);
    postToPlatformMock.mockResolvedValue({
      success: true,
      platformPostId: "tw-1",
    });
    fake.results = [
      [], [], // ensure
      [], // SELECT campaigns
      [], // INSERT marketing_posts
      [], // UPDATE → posted
      [], // UPDATE last_posted_at
    ];

    const { __resetMarketingTablesFlag } = await import("./ensure-tables");
    __resetMarketingTablesFlag();
    const { runMarketingCycle } = await import("./index");
    const result = await runMarketingCycle();

    expect(result.posted).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("skips youtube for non-video posts", async () => {
    const YT = { ...X_ACCOUNT, id: "y", platform: "youtube" };
    getActiveAccountsMock.mockResolvedValue([YT]);
    pickTopPostsMock.mockResolvedValue([SAMPLE_POST]); // image, not video
    fake.results = [[], [], []];

    const { __resetMarketingTablesFlag } = await import("./ensure-tables");
    __resetMarketingTablesFlag();
    const { runMarketingCycle } = await import("./index");
    const result = await runMarketingCycle();

    expect(result.skipped).toBe(1);
    expect(result.details[0]!.status).toBe("skipped");
  });

  it("flags platform failures in details", async () => {
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    pickTopPostsMock.mockResolvedValue([SAMPLE_POST]);
    postToPlatformMock.mockResolvedValue({
      success: false,
      error: "rate limited",
    });
    fake.results = [[], [], [], [], []];

    const { __resetMarketingTablesFlag } = await import("./ensure-tables");
    __resetMarketingTablesFlag();
    const { runMarketingCycle } = await import("./index");
    const result = await runMarketingCycle();

    expect(result.failed).toBe(1);
    expect(result.details[0]!.error).toBe("rate limited");
  });
});
