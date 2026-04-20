import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

// Route is a thin wrapper — stub the library so route tests focus on auth + passthrough
const collectMock = vi.fn();
vi.mock("@/lib/marketing", () => ({
  collectAllMetrics: () => collectMock(),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  collectMock.mockReset();
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
});

async function callGET(auth?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/marketing-metrics", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}

async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/marketing-metrics", { method: "POST" }));
}

describe("GET /api/marketing-metrics", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("401 with wrong token", async () => {
    expect((await callGET("Bearer wrong")).status).toBe(401);
  });

  it("returns collector result wrapped in cron run id", async () => {
    collectMock.mockResolvedValue({ updated: 3, failed: 1, details: [] });
    fake.results = [[], [], []]; // CREATE cron_runs + INSERT + UPDATE

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      failed: number;
      details: unknown[];
      _cron_run_id: string;
    };
    expect(body.updated).toBe(3);
    expect(body.failed).toBe(1);
    expect(typeof body._cron_run_id).toBe("string");
  });

  it("returns 500 when collector throws", async () => {
    collectMock.mockRejectedValue(new Error("boom"));
    fake.results = [[], [], []];
    expect((await callGET("Bearer secret")).status).toBe(500);
  });
});

describe("POST /api/marketing-metrics", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin", async () => {
    mockIsAdmin = true;
    collectMock.mockResolvedValue({ updated: 0, failed: 0, details: [] });
    const res = await callPOST();
    expect(res.status).toBe(200);
    expect(collectMock).toHaveBeenCalledOnce();
  });
});
