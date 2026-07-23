import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };

function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

vi.mock("@/lib/x-oauth", () => ({
  getAppCredentials: vi.fn(),
  buildOAuth1Header: vi.fn().mockReturnValue("OAuth oauth_signature=fake"),
}));

const sendTelegramPhotoMock = vi.fn();
const sendTelegramVideoMock = vi.fn();
vi.mock("@/lib/telegram", () => ({
  sendTelegramPhoto: (...a: unknown[]) => sendTelegramPhotoMock(...a),
  sendTelegramVideo: (...a: unknown[]) => sendTelegramVideoMock(...a),
}));

import { getAppCredentials } from "@/lib/x-oauth";
import {
  buildFacebookPlatformUrl,
  facebookGraphIdsMatch,
  facebookSpreadNote,
  fetchFacebookPostEngagement,
  findFacebookEngagementViaPublishedPosts,
  getActiveAccounts,
  getAnyAccountForPlatform,
  normalizeFacebookPostId,
  postToPlatform,
  resolveFacebookMetricsPostId,
  testPlatformToken,
  type PostResult,
} from "./platforms";

const X_ACCOUNT = {
  id: "acc-x",
  platform: "x" as const,
  account_name: "aiglitch",
  account_id: "1",
  account_url: "https://x.com/aiglitch",
  access_token: "tok",
  refresh_token: "",
  token_expires_at: null,
  extra_config: "{}",
  is_active: true,
  last_posted_at: null,
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
};

beforeEach(() => {
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.mocked(getAppCredentials).mockReset();
  vi.mocked(getAppCredentials).mockReturnValue({
    apiKey: "k",
    apiSecret: "s",
    accessToken: "at",
    accessTokenSecret: "ats",
  } as unknown as ReturnType<typeof getAppCredentials>);
  sendTelegramPhotoMock.mockReset();
  sendTelegramVideoMock.mockReset();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_USER_ID;
  delete process.env.FACEBOOK_ACCESS_TOKEN;
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_GROUP_ID;
  delete process.env.FACEBOOK_DAILY_POST_LIMIT;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getAnyAccountForPlatform", () => {
  it("returns the inactive DB row when no active one exists", async () => {
    fake.results = [
      [{ ...X_ACCOUNT, is_active: false }],
    ];
    const result = await getAnyAccountForPlatform("x");
    expect(result?.id).toBe("acc-x");
    expect(result?.is_active).toBe(false);
  });

  it("falls back to env-only synthesized account when DB row missing", async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = "ig-token";
    process.env.INSTAGRAM_USER_ID = "ig-user";
    fake.results = [[]];
    const result = await getAnyAccountForPlatform("instagram");
    expect(result?.id).toBe("env-instagram");
    expect(result?.access_token).toBe("ig-token");
  });
});

describe("getActiveAccounts", () => {
  it("merges DB rows + env-only platforms with no DB row", async () => {
    process.env.FACEBOOK_ACCESS_TOKEN = "fb-tok";
    process.env.FACEBOOK_PAGE_ID = "fb-page";
    fake.results = [[X_ACCOUNT]];

    const accounts = await getActiveAccounts();
    expect(accounts.map((a) => a.platform).sort()).toEqual(["facebook", "x"]);
  });

  it("env-only accounts are NOT duplicated when a DB row exists", async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = "ig-tok";
    process.env.INSTAGRAM_USER_ID = "ig-user";
    fake.results = [
      [
        {
          ...X_ACCOUNT,
          id: "db-ig",
          platform: "instagram",
          account_name: "ig-from-db",
        },
      ],
    ];

    const accounts = await getActiveAccounts();
    const igAccounts = accounts.filter((a) => a.platform === "instagram");
    expect(igAccounts.length).toBe(1);
    expect(igAccounts[0]!.id).toBe("db-ig");
    // env override of access_token still applied
    expect(igAccounts[0]!.access_token).toBe("ig-tok");
  });
});

describe("testPlatformToken", () => {
  it("returns ok:false when X env vars are not configured", async () => {
    vi.mocked(getAppCredentials).mockReturnValue(
      null as unknown as ReturnType<typeof getAppCredentials>,
    );
    const result = await testPlatformToken("x");
    expect(result.ok).toBe(false);
  });

  it("returns ok:true when /2/users/me responds 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      }),
    );
    const result = await testPlatformToken("x");
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with HTTP code on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      }),
    );
    const result = await testPlatformToken("x");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("returns ok:true for unported platforms (no false-flag)", async () => {
    expect((await testPlatformToken("instagram")).ok).toBe(true);
    expect((await testPlatformToken("facebook")).ok).toBe(true);
    expect((await testPlatformToken("youtube")).ok).toBe(true);
  });
});

describe("postToPlatform — X", () => {
  it("posts text via /2/tweets and returns the tweet id + URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({ data: { id: "t-123" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postToPlatform("x", X_ACCOUNT, "hello world");
    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe("t-123");
    expect(result.platformUrl).toBe("https://x.com/aiglitch/status/t-123");

    const init = fetchMock.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ text: "hello world" });
  });

  it("logs and ignores media URL (chunked upload deferred)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({ data: { id: "t-1" } }),
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await postToPlatform(
      "x",
      X_ACCOUNT,
      "with media",
      "https://cdn/v.mp4",
    );
    expect(result.success).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns failure with error body on non-2xx X response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("forbidden"),
      }),
    );
    const result = await postToPlatform("x", X_ACCOUNT, "x");
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
    expect(result.error).toContain("forbidden");
  });

  it("returns failure when no OAuth1 creds AND no DB access token", async () => {
    vi.mocked(getAppCredentials).mockReturnValue(
      null as unknown as ReturnType<typeof getAppCredentials>,
    );
    const noTokenAccount = { ...X_ACCOUNT, access_token: "" };
    const result = await postToPlatform("x", noTokenAccount, "x");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No X OAuth1");
  });
});

describe("postToPlatform — deferred platforms", () => {
  it("instagram rejects when no media URL is supplied", async () => {
    // Instagram is now wired through postToInstagram; it requires a
    // media URL up-front and rejects text-only attempts before ever
    // touching the Graph API.
    const result: PostResult = await postToPlatform(
      "instagram",
      { ...X_ACCOUNT, platform: "instagram" },
      "x",
    );
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("instagram");
  });

  it("returns success:false when facebook page credentials are missing", async () => {
    const result = await postToPlatform(
      "facebook",
      { ...X_ACCOUNT, platform: "facebook", access_token: "", account_id: "" },
      "x",
    );
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("facebook");
  });

  it("fetchFacebookPostEngagement resolves feed post_id for photo uploads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              reactions: { summary: { total_count: 0 } },
              comments: { summary: { total_count: 0 } },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            post_id: "1041648825691964_999888777666",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              reactions: { summary: { total_count: 2 } },
              comments: { summary: { total_count: 1 } },
              shares: { count: 0 },
            }),
          ),
      });
    vi.stubGlobal("fetch", fetchMock);

    const engagement = await fetchFacebookPostEngagement(
      "1041648825691964",
      "1731588724411517",
      "fb-tok",
    );
    expect(engagement?.comments).toBe(1);
    expect(engagement?.feedPostId).toBe("1041648825691964_999888777666");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fetchFacebookPostEngagement reads comments on feed posts directly", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            reactions: { summary: { total_count: 1 } },
            comments: { summary: { total_count: 2 } },
            shares: { count: 0 },
          }),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engagement = await fetchFacebookPostEngagement(
      "1041648825691964",
      "1041648825691964_1731588724411517",
      "fb-tok",
    );
    expect(engagement?.comments).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolveFacebookMetricsPostId uses feed post_id for photo uploads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              reactions: { summary: { total_count: 0 } },
              comments: { summary: { total_count: 0 } },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            post_id: "1041648825691964_999888777666",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              reactions: { summary: { total_count: 0 } },
              comments: { summary: { total_count: 1 } },
            }),
          ),
      });
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveFacebookMetricsPostId(
      "1041648825691964",
      "1731588724411517",
      "fb-tok",
    );
    expect(resolved).toBe("1041648825691964_999888777666");
  });

  it("normalizeFacebookPostId prefixes bare photo ids with page id", () => {
    expect(
      normalizeFacebookPostId("1041648825691964", "1731588724411517"),
    ).toBe("1041648825691964_1731588724411517");
    expect(
      normalizeFacebookPostId(
        "1041648825691964",
        "1041648825691964_122119083495145886",
      ),
    ).toBe("1041648825691964_122119083495145886");
  });

  it("facebookGraphIdsMatch treats bare photo ids as equivalent to feed post suffix", () => {
    expect(
      facebookGraphIdsMatch(
        "1041648825691964",
        "1731588724411517",
        "1041648825691964_1731588724411517",
      ),
    ).toBe(true);
    expect(
      facebookGraphIdsMatch(
        "1041648825691964",
        "1041648825691964_122119095897145886",
        "1041648825691964_122119095897145886",
      ),
    ).toBe(true);
  });

  it("fetchFacebookPostEngagement falls back to published_posts when direct photo read is blocked", async () => {
    const postedAt = "2026-05-03T14:53:18+0000";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: { message: "(#200) Missing Permissions", code: 200 },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            error: { message: "(#200) Missing Permissions", code: 200 },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "1041648825691964_122119095897145886",
                created_time: postedAt,
                reactions: { summary: { total_count: 3 } },
                comments: { summary: { total_count: 2 } },
                shares: { count: 1 },
              },
            ],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const engagement = await fetchFacebookPostEngagement(
      "1041648825691964",
      "1731588724411517",
      "fb-tok",
      { postedAt },
    );
    expect(engagement?.comments).toBe(2);
    expect(engagement?.likes).toBe(3);
    expect(engagement?.feedPostId).toBe("1041648825691964_122119095897145886");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("findFacebookEngagementViaPublishedPosts matches by posted_at when ids differ", async () => {
    const postedAt = "2026-05-03T14:53:18+0000";
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [
            {
              id: "1041648825691964_122119095897145886",
              created_time: postedAt,
              reactions: { summary: { total_count: 1 } },
              comments: { summary: { total_count: 4 } },
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findFacebookEngagementViaPublishedPosts(
      "1041648825691964",
      "1731588724411517",
      "fb-tok",
      { postedAt: "2026-05-03T14:53:20.000Z" },
    );
    expect(found?.feedPostId).toBe("1041648825691964_122119095897145886");
    expect(found?.engagement.comments).toBe(4);
  });

  it("buildFacebookPlatformUrl uses feed post permalink for page photos", () => {
    const url = buildFacebookPlatformUrl("1041648825691964", "1041648825691964_122119083495145886", {
      isVideo: false,
      hasMedia: true,
    });
    expect(url).toBe(
      "https://www.facebook.com/1041648825691964/posts/122119083495145886",
    );
    expect(url).not.toContain("photo/?fbid=");
  });

  it("fetches permalink_url for page photo posts when Graph provides it", async () => {
    process.env.FACEBOOK_GROUP_ID = "1608814267525689";
    fake.results = [[{ count: 0 }]];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: "1041648825691964_122119083495145886",
            post_id: "1041648825691964_122119083495145886",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            permalink_url: "https://www.facebook.com/share/p/1CnQ8Qq9Hk/",
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postToPlatform(
      "facebook",
      {
        ...X_ACCOUNT,
        platform: "facebook",
        account_id: "1041648825691964",
        access_token: "fb-tok",
      },
      "hello fb",
      "https://blob.test/ad.png",
    );

    expect(result.success).toBe(true);
    expect(result.platformUrl).toBe("https://www.facebook.com/share/p/1CnQ8Qq9Hk/");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adds manual group share note when FACEBOOK_GROUP_ID is set (Groups API dead)", async () => {
    process.env.FACEBOOK_GROUP_ID = "1608814267525689";
    fake.results = [[{ count: 0 }]]; // throttle COUNT query

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "111" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              reactions: { summary: { total_count: 0 } },
              comments: { summary: { total_count: 0 } },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ post_id: "fb-page_999feedpost" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              reactions: { summary: { total_count: 0 } },
              comments: { summary: { total_count: 0 } },
            }),
          ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ permalink_url: undefined }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postToPlatform(
      "facebook",
      {
        ...X_ACCOUNT,
        platform: "facebook",
        account_id: "fb-page",
        access_token: "fb-tok",
      },
      "hello fb",
    );

    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe("fb-page_999feedpost");
    expect(fetchMock).toHaveBeenCalledTimes(5); // post + engagement + probe + feed + permalink
    expect(result.secondaryError).toContain("Meta removed Groups API");
    expect(facebookSpreadNote(result)).toContain("manual");
  });

  it("returns success:false when youtube has no video URL", async () => {
    const result = await postToPlatform(
      "youtube",
      { ...X_ACCOUNT, platform: "youtube", access_token: "tok" },
      "hello",
      null,
      {
        youtube: {
          title: "Test title",
          description: "Test description",
          privacyStatus: "public",
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("video");
  });

  it("catches unexpected exceptions in the dispatcher", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await postToPlatform("x", X_ACCOUNT, "x");
    expect(result.success).toBe(false);
    expect(result.error).toContain("network down");
    errSpy.mockRestore();
  });
});

describe("postToPlatform — Telegram media dispatch", () => {
  const TG_ACCOUNT = {
    ...X_ACCOUNT,
    id: "acc-tg",
    platform: "telegram" as const,
    account_name: "aiglitch_channel",
    account_id: "@aiglitch_channel",
    access_token: "bot-token",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "1000000" },
          });
        }
        if (url.includes("api.telegram.org")) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 99 } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("routes MP4 URLs through sendTelegramVideo (not sendPhoto)", async () => {
    sendTelegramVideoMock.mockResolvedValue({ ok: true, messageId: 42 });
    const result = await postToPlatform(
      "telegram",
      TG_ACCOUNT,
      "caption",
      "https://blob.test/breaking-news/stitched/2026-06-05/t1.mp4",
    );
    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe("42");
    expect(sendTelegramVideoMock).toHaveBeenCalledOnce();
    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it("routes image URLs through sendTelegramPhoto", async () => {
    sendTelegramPhotoMock.mockResolvedValue({ ok: true, messageId: 7 });
    const result = await postToPlatform(
      "telegram",
      TG_ACCOUNT,
      "caption",
      "https://blob.test/hero/img.jpg",
    );
    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe("7");
    expect(sendTelegramPhotoMock).toHaveBeenCalledOnce();
    expect(sendTelegramVideoMock).not.toHaveBeenCalled();
  });

  it("ignores query strings when detecting video extension", async () => {
    sendTelegramVideoMock.mockResolvedValue({ ok: true, messageId: 1 });
    await postToPlatform(
      "telegram",
      TG_ACCOUNT,
      "c",
      "https://blob.test/v.mp4?sig=abc",
    );
    expect(sendTelegramVideoMock).toHaveBeenCalledOnce();
    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it("falls back to text-only when video upload exceeds Telegram size cap", async () => {
    sendTelegramVideoMock.mockResolvedValue({
      ok: false,
      error: "file too big",
    });
    const result = await postToPlatform(
      "telegram",
      TG_ACCOUNT,
      "c",
      "https://blob.test/v.mp4",
    );
    expect(result.success).toBe(true);
    expect(result.error).toContain("text-only");
    expect(result.error).toContain("50MB");
  });
});
