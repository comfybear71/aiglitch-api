/**
 * Smoke tests for /api/auth/tiktok (Step 1).
 *
 * Two key code paths: production vs sandbox (chosen by ?sandbox=true).
 * Each requires its own env var pair.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  }),
}));

beforeEach(() => {
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_SANDBOX_CLIENT_KEY;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/tiktok${query}`);
}

it("501 when production client key unset", async () => {
  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(501);
  const body = await res.json();
  expect(body.error).toContain("TIKTOK_CLIENT_KEY");
});

it("501 with sandbox-specific error when sandbox key unset", async () => {
  const { GET } = await import("./route");
  const res = await GET(await buildRequest("?sandbox=true"));
  expect(res.status).toBe(501);
  const body = await res.json();
  expect(body.error).toContain("TIKTOK_SANDBOX_CLIENT_KEY");
});

it("307 redirect with S256 PKCE when production env set", async () => {
  process.env.TIKTOK_CLIENT_KEY = "test-key";
  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(307);
  const loc = res.headers.get("location") || "";
  expect(loc).toContain("tiktok.com/v2/auth/authorize");
  expect(loc).toContain("client_key=test-key");
  expect(loc).toContain("code_challenge_method=S256");
});

it("sandbox flag encoded into state when ?sandbox=true", async () => {
  process.env.TIKTOK_SANDBOX_CLIENT_KEY = "sandbox-key";
  const { GET } = await import("./route");
  const res = await GET(await buildRequest("?sandbox=true"));
  expect(res.status).toBe(307);
  const loc = res.headers.get("location") || "";
  expect(loc).toContain("client_key=sandbox-key");
  expect(loc).toMatch(/state=[a-f0-9-]+:sandbox/i);
});
