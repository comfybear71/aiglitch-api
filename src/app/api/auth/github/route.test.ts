/**
 * Smoke tests for /api/auth/github (Step 1).
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  delete process.env.GITHUB_CLIENT_ID;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("501 when GITHUB_CLIENT_ID is unset", async () => {
  const { GET } = await import("./route");
  const res = await GET();
  expect(res.status).toBe(501);
});

it("307 redirect to github.com when env is set", async () => {
  process.env.GITHUB_CLIENT_ID = "test-client";
  const { GET } = await import("./route");
  const res = await GET();
  expect(res.status).toBe(307);
  const location = res.headers.get("location") || "";
  expect(location).toContain("github.com/login/oauth/authorize");
  expect(location).toContain("client_id=test-client");
});
