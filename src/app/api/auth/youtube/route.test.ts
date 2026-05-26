/**
 * Smoke tests for /api/auth/youtube (Step 1, admin-only).
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));

beforeEach(() => {
  delete process.env.YOUTUBE_CLIENT_ID;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildRequest() {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/auth/youtube");
}

it("401 without admin auth", async () => {
  const { isAdminAuthenticated } = await import("@/lib/admin-auth");
  (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(401);
});

it("501 when admin authed but YOUTUBE_CLIENT_ID unset", async () => {
  const { isAdminAuthenticated } = await import("@/lib/admin-auth");
  (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(501);
});

it("307 redirect to Google when admin + env set", async () => {
  process.env.YOUTUBE_CLIENT_ID = "yt-client";
  const { isAdminAuthenticated } = await import("@/lib/admin-auth");
  (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

  const { GET } = await import("./route");
  const res = await GET(await buildRequest());
  expect(res.status).toBe(307);
  const loc = res.headers.get("location") || "";
  expect(loc).toContain("accounts.google.com");
  expect(loc).toContain("client_id=yt-client");
  expect(loc).toContain("youtube.upload");
});
