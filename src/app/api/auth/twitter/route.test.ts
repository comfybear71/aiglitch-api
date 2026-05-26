/**
 * Smoke tests for /api/auth/twitter (Step 1).
 *
 * Note: this route writes the PKCE code_verifier + state into cookies
 * via next/headers. The vitest harness can call the handler but the
 * cookie writes are inert in test mode — what we assert here is the
 * 501/redirect shape.
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
  delete process.env.TWITTER_CLIENT_ID;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("501 when TWITTER_CLIENT_ID is unset", async () => {
  const { GET } = await import("./route");
  const res = await GET();
  expect(res.status).toBe(501);
});

it("307 redirect to twitter.com with PKCE params when env is set", async () => {
  process.env.TWITTER_CLIENT_ID = "test-client";
  const { GET } = await import("./route");
  const res = await GET();
  expect(res.status).toBe(307);
  const loc = res.headers.get("location") || "";
  expect(loc).toContain("twitter.com/i/oauth2/authorize");
  expect(loc).toContain("client_id=test-client");
  expect(loc).toContain("code_challenge=");
  expect(loc).toContain("code_challenge_method=plain");
});
