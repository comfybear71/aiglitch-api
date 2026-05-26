/**
 * Smoke tests for /api/auth/google (Step 1 — consent redirect).
 *
 * Pins:
 *   - 501 when GOOGLE_CLIENT_ID is unset
 *   - 307 redirect to accounts.google.com when env is set
 *   - WebView UA returns the wallet-login fallback HTML
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildRequest(headers: Record<string, string> = {}) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/auth/google", { headers });
}

it("501 when GOOGLE_CLIENT_ID is unset", async () => {
  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(501);
});

it("307 redirect to Google when env is set", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client";
  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(307);
  const location = res.headers.get("location") || "";
  expect(location).toContain("accounts.google.com");
  expect(location).toContain("client_id=test-client");
});

it("WebView UA returns wallet-login HTML fallback", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client";
  const { GET } = await import("./route");
  const res = await GET(
    await buildRequest({ "user-agent": "Mozilla/5.0 (Phantom/24.0)" }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const text = await res.text();
  expect(text).toContain("Sign in with Wallet");
});
