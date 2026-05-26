/**
 * Smoke tests for /api/auth/callback/tiktok — error gates only.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: vi.fn(),
    get: vi.fn(() => ({ value: "test" })),
    delete: vi.fn(),
  }),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/callback/tiktok${query}`);
}

function expectRedirectTo(res: Response, fragment: string) {
  expect([302, 307]).toContain(res.status);
  expect(res.headers.get("location") || "").toContain(fragment);
}

it("redirects with tiktok_error when provider passes error param", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest("?error=access_denied")), "tiktok_error=access_denied");
});

it("redirects with tiktok_error=no_code when code is missing", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(await GET(await buildRequest()), "tiktok_error=no_code");
});

it("redirects with not_configured suffix matching mode", async () => {
  const { GET } = await import("./route");
  expectRedirectTo(
    await GET(await buildRequest("?code=x&state=abc:sandbox")),
    "tiktok_error=not_configured_sandbox",
  );
});
