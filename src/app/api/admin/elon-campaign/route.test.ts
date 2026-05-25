/**
 * Tests for /api/admin/elon-campaign.
 *
 * The route's real pipeline (Claude → xAI video → MP4 stitch → DB
 * insert → social spread) is integration-heavy and not unit-testable
 * without exercising real APIs. These tests cover the surface that
 * IS unit-testable:
 *
 *   - Auth gating (admin required, cron path accepts CRON_SECRET)
 *   - Idempotency: `action=cron` short-circuits when today's row exists
 *   - `action=preview_prompt` returns the assembled prompt without firing
 *   - `action=reset` deletes campaign rows + associated posts
 *   - Default GET returns history shape with currentDay / nextTheme
 *   - POST requires admin
 *
 * The runCampaignDay pipeline itself is mocked out via the AI / video /
 * blob / spread module mocks below — we assert call ordering and DB
 * state changes, not media-rendering correctness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));
vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn(),
}));
vi.mock("@/lib/ai/claude", () => ({
  generateJSON: vi.fn(),
}));
vi.mock("@/lib/ai/video", () => ({
  submitVideoJob: vi.fn(),
}));
vi.mock("@/lib/media/mp4-concat", () => ({
  concatMP4Clips: vi.fn(() => Buffer.from("stitched")),
}));
vi.mock("@/lib/marketing/spread-post", () => ({
  spreadPostToSocial: vi.fn(async () => ({ platforms: [], failed: [] })),
}));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async () => ({ url: "https://blob/x.mp4" })),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.XAI_API_KEY = "test-xai-key";
  process.env.CRON_SECRET = "test-cron-secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.XAI_API_KEY;
  delete process.env.CRON_SECRET;
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/admin/elon-campaign${query}`, init);
}

describe("GET /api/admin/elon-campaign", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { GET } = await import("./route");
    const req = await buildRequest();
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns history + currentDay + nextTheme when admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      // history rows
      [
        {
          id: "c1",
          day_number: 2,
          title: "Day 2: Architect Needs You",
          tone: "devotion",
          video_url: "https://blob/d2.mp4",
          post_id: "p1",
          status: "posted",
          caption: "cap",
          elon_engagement: null,
          x_post_id: null,
          created_at: "2026-05-25T00:00:00Z",
          completed_at: "2026-05-25T00:05:00Z",
        },
      ],
      // getCurrentDay
      [{ max_day: 2 }],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.currentDay).toBe(3);
    expect(body.nextTheme.title).toMatch(/Day 3/);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].dayNumber).toBe(2);
    expect(body.totalDays).toBe(1);
    expect(body.elonNoticed).toBe(false);
  });

  it("preview_prompt returns assembled prompt + day", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ max_day: 0 }], // getCurrentDay → 1
      [], // getPreviousDay (no prior day for Day 1, short-circuits but still called)
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=preview_prompt"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.dayNumber).toBe(1);
    expect(body.theme).toMatch(/Day 1/);
    expect(body.prompt).toMatch(/Director of The Elon Button/);
  });

  it("reset deletes campaign rows + their posts", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      // SELECT id, post_id FROM elon_campaign
      [
        { id: "c1", post_id: "p1" },
        { id: "c2", post_id: null }, // no post to delete
      ],
      // DELETE FROM posts (p1)
      [],
      // DELETE FROM elon_campaign
      [],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=reset"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.deleted).toEqual({ campaigns: 2, posts: 1 });
  });

  it("cron path: 401 when neither admin nor cron auth", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { requireCronAuth } = await import("@/lib/cron-auth");
    const { NextResponse } = await import("next/server");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    expect(res.status).toBe(401);
  });

  it("cron path: idempotent — skips when today's row already exists", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { requireCronAuth } = await import("@/lib/cron-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(null);

    fake.results = [
      // existing row found for today
      [{ id: "already" }],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(body.reason).toMatch(/Already posted today/);
  });
});

describe("POST /api/admin/elon-campaign", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const req = await buildRequest("", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("500 when screenplay generation returns null", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { generateJSON } = await import("@/lib/ai/claude");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (generateJSON as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    fake.results = [
      [{ max_day: 0 }], // getCurrentDay → 1
      [], // INSERT INTO elon_campaign
      [], // getPreviousDay returns nothing
      [], // UPDATE elon_campaign SET status='failed'
    ];

    const { POST } = await import("./route");
    const req = await buildRequest("", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Screenplay/);
  });
});
