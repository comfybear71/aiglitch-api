/**
 * Smoke tests for /api/activity-throttle (platform_settings shape).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/activity-throttle${query}`, init);
}

describe("GET", () => {
  it("default returns { throttle: 100 } when no row", async () => {
    fake.results = [[]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ throttle: 100 });
  });

  it("reads stored throttle value", async () => {
    fake.results = [[{ value: "65" }]];
    const { GET } = await import("./route");
    const body = await (await GET(await buildRequest())).json();
    expect(body.throttle).toBe(65);
  });

  it("?action=job_states returns throttle + per-job pause map", async () => {
    fake.results = [
      [{ value: "80" }],
      [
        { key: "cron_paused_persona-content", value: "true" },
        { key: "cron_paused_marketing-post", value: "false" },
      ],
    ];
    const { GET } = await import("./route");
    const body = await (await GET(await buildRequest("?action=job_states"))).json();
    expect(body.throttle).toBe(80);
    expect(body.jobStates).toEqual({
      "persona-content": true,
      "marketing-post": false,
    });
  });
});

describe("POST", () => {
  it("401 without admin auth", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ throttle: 50 }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("sets global throttle (clamped 0-100)", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    fake.results = [[]]; // INSERT UPSERT

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ throttle: 250 }), // over 100 → clamped to 100
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ throttle: 100 });
  });

  it("toggle_job flips the per-job pause flag", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    fake.results = [
      [{ value: "false" }], // current state
      [], // UPSERT result
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "toggle_job",
          job_name: "persona-content",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: "persona-content", paused: true });
  });

  it("toggle_job 400 without job_name", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "toggle_job" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
