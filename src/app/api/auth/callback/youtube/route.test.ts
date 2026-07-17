/**
 * Smoke tests for /api/auth/callback/youtube — error branches.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/callback/youtube${query}`);
}

function expectRedirectTo(res: Response, fragment: string) {
  expect([302, 307]).toContain(res.status);
  expect(res.headers.get("location") || "").toContain(fragment);
}

it("redirects with yt_error=no_code when no code param", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest()), "yt_error=no_code");
});

it("redirects with yt_error=not_configured when env unset", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest("?code=x")), "yt_error=not_configured");
});

it("redirects with yt_error=token_failed on Google rejection", async () => {
  process.env.YOUTUBE_CLIENT_ID = "id";
  process.env.YOUTUBE_CLIENT_SECRET = "secret";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({ error: "invalid_grant" }) })),
  );

  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest("?code=x")), "yt_error=token_failed");
});
