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

const adaptContentForPlatformMock = vi.fn();
vi.mock("./content-adapter", () => ({
  adaptContentForPlatform: (...args: unknown[]) =>
    adaptContentForPlatformMock(...args),
}));

const getActiveAccountsMock = vi.fn();
const postToPlatformMock = vi.fn();
vi.mock("./platforms", () => ({
  getActiveAccounts: (...args: unknown[]) => getActiveAccountsMock(...args),
  postToPlatform: (...args: unknown[]) => postToPlatformMock(...args),
}));

const sendTelegramMessageMock = vi.fn();
const rewriteMentionsForTelegramMock = vi.fn();
vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => sendTelegramMessageMock(...args),
  rewriteMentionsForTelegram: (...args: unknown[]) =>
    rewriteMentionsForTelegramMock(...args),
}));

const X_ACCOUNT = {
  id: "acc-x",
  platform: "x" as const,
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
const IG_ACCOUNT = { ...X_ACCOUNT, id: "acc-ig", platform: "instagram" as const };
const YT_ACCOUNT = { ...X_ACCOUNT, id: "acc-yt", platform: "youtube" as const };

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.clearAllMocks();
  rewriteMentionsForTelegramMock.mockImplementation(async (t: string) => t);
  sendTelegramMessageMock.mockResolvedValue({ ok: true });
  adaptContentForPlatformMock.mockResolvedValue({
    text: "adapted text",
    hashtags: ["#x"],
    callToAction: "x",
    thumbnailPrompt: "x",
  });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("spreadPostToSocial — happy path", () => {
  it("posts to active platforms and pushes a Telegram summary", async () => {
    fake.results = [
      [{ content: "hello", media_url: "https://cdn/img.png", media_type: "image" }],
      [], // INSERT marketing_posts (X attempt)
      [], // UPDATE marketing_posts → posted
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({
      success: true,
      platformPostId: "tweet-1",
      platformUrl: "https://x.com/x/status/tweet-1",
    });

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial(
      "post-1",
      "p-1",
      "Persona",
      "🚀",
    );
    expect(result.platforms).toContain("x");
    expect(result.platforms).toContain("telegram");
    expect(result.failed).toEqual([]);
    expect(sendTelegramMessageMock).toHaveBeenCalled();
  });

  it("uses knownMedia override when DB returned null media", async () => {
    fake.results = [
      [{ content: "hi", media_url: null, media_type: null }],
      [], // background UPDATE patch
      [], // INSERT marketing_posts
      [], // UPDATE marketing_posts → posted
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial(
      "p1",
      "px",
      "P",
      "🚀",
      { url: "https://cdn/v.mp4", type: "video/mp4" },
    );

    const adaptCall = adaptContentForPlatformMock.mock.calls[0];
    expect(adaptCall[4]).toBe("https://cdn/v.mp4");
    expect(result.platforms).toContain("x");
    warnSpy.mockRestore();
  });
});

describe("spreadPostToSocial — platform filtering", () => {
  it("skips youtube when post is not video", async () => {
    fake.results = [
      [
        {
          content: "img post",
          media_url: "https://cdn/img.jpg",
          media_type: "image",
        },
      ],
      [], // X insert
      [], // X update
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT, YT_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial("p1", "px", "P", "🚀");

    expect(result.platforms).not.toContain("youtube");
    expect(adaptContentForPlatformMock).toHaveBeenCalledTimes(1);
  });

  it("skips instagram when no media is available (after fallback)", async () => {
    fake.results = [
      [{ content: "text only", media_url: null, media_type: null }],
      [], // pickFallbackMedia preferVideo branch (returns nothing)
      [], // pickFallbackMedia recent branch
      [], // pickFallbackMedia broader
      [], // X insert
      [], // X update
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT, IG_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial("p1", "px", "P", "🚀");

    expect(result.platforms).not.toContain("instagram");
  });
});

describe("spreadPostToSocial — failure handling", () => {
  it("flags failed platforms in result.failed and updates marketing_posts row", async () => {
    fake.results = [
      [{ content: "hi", media_url: null, media_type: null }],
      [], // pickFallbackMedia (no video preference) returns nothing
      [], // recent
      [], // broader
      [], // INSERT marketing_posts
      [], // UPDATE marketing_posts → failed
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({
      success: false,
      error: "rate limited",
    });

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial("p1", "px", "P", "🚀");
    expect(result.failed).toContain("x");
    expect(result.platforms).not.toContain("x");
    expect(result.platforms).toContain("telegram");
  });

  it("returns gracefully when post does not exist", async () => {
    fake.results = [[]]; // empty post lookup
    getActiveAccountsMock.mockResolvedValue([]);

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial("missing", "px", "P", "🚀");
    expect(result.platforms).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("non-fatal Telegram push failure leaves platforms list intact", async () => {
    fake.results = [
      [{ content: "x", media_url: "https://cdn/x.png", media_type: "image" }],
      [],
      [],
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });
    sendTelegramMessageMock.mockRejectedValue(new Error("tg down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { spreadPostToSocial } = await import("./spread-post");
    const result = await spreadPostToSocial("p1", "px", "P", "🚀");
    expect(result.platforms).toContain("x");
    expect(result.platforms).not.toContain("telegram");
    errSpy.mockRestore();
  });
});

describe("pickFallbackMedia", () => {
  it("returns null when no media exists in any range", async () => {
    fake.results = [[], []]; // recent + broader both empty
    const { pickFallbackMedia } = await import("./spread-post");
    expect(await pickFallbackMedia()).toBeNull();
  });

  it("returns the first hit from preferVideo branch when preferVideo=true", async () => {
    fake.results = [[{ media_url: "https://cdn/v.mp4" }]];
    const { pickFallbackMedia } = await import("./spread-post");
    expect(await pickFallbackMedia(true)).toBe("https://cdn/v.mp4");
  });

  it("returns broader fallback when 7-day query is empty but 30-day has results", async () => {
    fake.results = [
      [], // recent (7-day) empty
      [{ media_url: "https://cdn/old.png" }],
    ];
    const { pickFallbackMedia } = await import("./spread-post");
    expect(await pickFallbackMedia()).toBe("https://cdn/old.png");
  });
});

describe("spreadPostToSocial — Telegram label variants", () => {
  it("uses 'MOVIE POSTED' label and shows just the title line", async () => {
    fake.results = [
      [
        {
          content: "Title Line\n\nLong synopsis...",
          media_url: "https://cdn/m.mp4",
          media_type: "video",
        },
      ],
      [],
      [],
    ];
    getActiveAccountsMock.mockResolvedValue([X_ACCOUNT]);
    postToPlatformMock.mockResolvedValue({ success: true });

    const { spreadPostToSocial } = await import("./spread-post");
    await spreadPostToSocial("p1", "px", "P", "🚀", undefined, "MOVIE POSTED");

    const tgCall = sendTelegramMessageMock.mock.calls[0][0] as string;
    expect(tgCall).toContain("MOVIE POSTED");
    expect(tgCall).toContain("Title Line");
    expect(tgCall).not.toContain("Long synopsis");
  });
});
