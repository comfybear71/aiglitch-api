import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

function mockFetch(ok = true, status = 200, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_URL;
  vi.restoreAllMocks();
});

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/cron-control"));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/cron-control", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("GET /api/admin/cron-control", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns cron registry with never_run status when cron_runs is empty", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], [{ total_runs: 0, successful: 0, failed: 0, total_cost: 0, unique_jobs: 0 }]];

    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cron_jobs: { name: string; last_status: string }[];
      stats_24h: { total_runs: number };
    };
    expect(body.cron_jobs.length).toBeGreaterThan(0);
    expect(body.cron_jobs.every((c) => c.last_status === "never_run")).toBe(true);
    expect(body.stats_24h.total_runs).toBe(0);
  });

  it("joins latest run data when cron_runs has entries", async () => {
    mockIsAdmin = true;
    fake.results = [
      [
        {
          id: "r1",
          cron_name: "sponsor-burn",
          status: "ok",
          started_at: "2026-04-21T00:00:00Z",
          finished_at: "2026-04-21T00:00:05Z",
          duration_ms: 5000,
          cost_usd: "0.0042",
          result: null,
          error: null,
        },
      ],
      [],
      [{ total_runs: 1, successful: 1, failed: 0, total_cost: 0.0042, unique_jobs: 1 }],
    ];

    const res = await callGET();
    const body = (await res.json()) as {
      cron_jobs: { name: string; last_status: string; last_cost_usd: number | null }[];
    };
    const sponsor = body.cron_jobs.find((c) => c.name === "sponsor-burn");
    expect(sponsor?.last_status).toBe("ok");
    expect(sponsor?.last_cost_usd).toBe(0.0042);
  });

  it("degrades gracefully when cron_runs table does not exist", async () => {
    mockIsAdmin = true;
    fake.results = [
      new Error("relation \"cron_runs\" does not exist"),
      new Error("relation \"cron_runs\" does not exist"),
      new Error("relation \"cron_runs\" does not exist"),
    ];

    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cron_jobs: unknown[]; stats_24h: { total_runs: number } };
    expect(body.cron_jobs.length).toBeGreaterThan(0);
    expect(body.stats_24h.total_runs).toBe(0);
  });
});

describe("POST /api/admin/cron-control", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ job: "sponsor-burn" })).status).toBe(401);
  });

  it("400 when job missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({})).status).toBe(400);
  });

  it("400 when job name is unknown", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ job: "not-a-real-job" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { available: string[] };
    expect(body.available).toContain("sponsor-burn");
  });

  it("500 when CRON_SECRET is not configured", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ job: "sponsor-burn" });
    expect(res.status).toBe(500);
  });

  it("triggers the endpoint with Bearer CRON_SECRET and returns the upstream result", async () => {
    mockIsAdmin = true;
    process.env.CRON_SECRET = "secret";
    const fetchMock = mockFetch(true, 200, { processed: 5 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({ job: "sponsor-burn" });
    expect(res.status).toBe(200);

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain("/api/sponsor-burn");
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer secret");

    const body = (await res.json()) as { success: boolean; endpoint: string; status: number };
    expect(body.success).toBe(true);
    expect(body.endpoint).toBe("/api/sponsor-burn");
    expect(body.status).toBe(200);
  });

  it("reports upstream non-2xx as success:false", async () => {
    mockIsAdmin = true;
    process.env.CRON_SECRET = "secret";
    vi.stubGlobal("fetch", mockFetch(false, 503, { error: "down" }));

    const res = await callPOST({ job: "sponsor-burn" });
    const body = (await res.json()) as { success: boolean; status: number };
    expect(body.success).toBe(false);
    expect(body.status).toBe(503);
  });
});
