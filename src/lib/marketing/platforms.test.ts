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

import { getAppCredentials } from "@/lib/x-oauth";
import {
  getActiveAccounts,
  getAnyAccountForPlatform,
  postToPlatform,
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
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_USER_ID;
  delete process.env.FACEBOOK_ACCESS_TOKEN;
  delete process.env.FACEBOOK_PAGE_ID;
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
  it("returns success:false with deferral message for instagram", async () => {
    const result: PostResult = await postToPlatform(
      "instagram",
      { ...X_ACCOUNT, platform: "instagram" },
      "x",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("DEFERRED");
  });

  it("returns success:false with deferral message for facebook", async () => {
    const result = await postToPlatform(
      "facebook",
      { ...X_ACCOUNT, platform: "facebook" },
      "x",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("facebook");
  });

  it("returns success:false with deferral message for youtube", async () => {
    const result = await postToPlatform(
      "youtube",
      { ...X_ACCOUNT, platform: "youtube" },
      "x",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("youtube");
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
