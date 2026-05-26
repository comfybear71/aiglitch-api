/**
 * Smoke tests for /api/auth/callback/github — early-return branches only.
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
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/callback/github${query}`);
}

function expectRedirectTo(res: Response, fragment: string) {
  expect([302, 307]).toContain(res.status);
  expect(res.headers.get("location") || "").toContain(fragment);
}

it("redirects with error=no_code when code is missing", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest()), "error=no_code");
});

it("redirects with error=not_configured when env missing", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest("?code=x")), "error=not_configured");
});

it("redirects with error=token_failed on auth rejection", async () => {
  process.env.GITHUB_CLIENT_ID = "id";
  process.env.GITHUB_CLIENT_SECRET = "secret";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest("?code=x")), "error=token_failed");
});
