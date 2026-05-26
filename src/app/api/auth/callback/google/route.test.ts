/**
 * Smoke tests for /api/auth/callback/google.
 *
 * Pins the early-return branches (no code, env unset, token exchange
 * failure, no email). The happy path is integration-tested in legacy;
 * here we only verify the error gates redirect to the consumer /me
 * page with the right query string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/callback/google${query}`);
}

function expectRedirectTo(res: Response, locationFragment: string) {
  expect([302, 307]).toContain(res.status);
  const loc = res.headers.get("location") || "";
  expect(loc).toContain(locationFragment);
}

it("redirects with error=no_code when code is missing", async () => {
  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expectRedirectTo(res, "error=no_code");
});

it("redirects with error=not_configured when env missing", async () => {
  const { GET } = await import("./route");
  const res = await GET(await buildRequest("?code=xyz"));
  expectRedirectTo(res, "error=not_configured");
});

it("redirects with error=token_failed when Google rejects the code", async () => {
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({ error: "bad_request" }) })),
  );

  const { GET } = await import("./route");
  const res = await GET(await buildRequest("?code=xyz"));
  expectRedirectTo(res, "error=token_failed");
});

it("redirects to /me with oauth_session when token + userinfo succeed", async () => {
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://aiglitch.app";
  // 1st fetch = token exchange, 2nd = userinfo
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ access_token: "tok" }) };
      return {
        ok: true,
        json: async () => ({ email: "alice@example.com", name: "Alice" }),
      };
    }),
  );
  // 1st sql = SELECT by email (empty), 2nd = SELECT username taken (empty), 3rd = INSERT
  fake.results = [[], [], []];

  const { GET } = await import("./route");
  const res = await GET(await buildRequest("?code=xyz"));
  expectRedirectTo(res, "oauth_session=");
  expect(res.headers.get("location") || "").toContain("oauth_provider=google");
  expect(res.headers.get("location") || "").toContain("aiglitch.app");

  delete process.env.NEXT_PUBLIC_APP_URL;
});
