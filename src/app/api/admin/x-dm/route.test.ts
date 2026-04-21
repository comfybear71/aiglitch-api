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

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/admin/x-dm${query}`));
}

async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/x-dm", { method: "POST" }));
}

describe("GET /api/admin/x-dm", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns empty logs + zero stats on fresh DB", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // CREATE TABLE
      [],  // SELECT logs
      [{ total: 0, replied: 0, failed: 0, oldest: null, newest: null }],
    ];
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      stats: { total: number };
      logs: unknown[];
    };
    expect(body.total).toBe(0);
    expect(body.stats.total).toBe(0);
  });

  it("returns up to ?limit= logs (clamped to 200)", async () => {
    mockIsAdmin = true;
    const logs = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}` }));
    fake.results = [
      [],
      logs,
      [{ total: 10, replied: 5, failed: 2, oldest: "x", newest: "y" }],
    ];
    const res = await callGET("?limit=999");
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(10);
    // Verify SELECT bound the clamped limit (200)
    expect(fake.calls[1].values[0]).toBe(200);
  });

  it("500 when the SELECT fails", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],   // CREATE TABLE
      new Error("boom"),
    ];
    expect((await callGET()).status).toBe(500);
  });
});

describe("POST /api/admin/x-dm", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("500 when CRON_SECRET is not set", async () => {
    mockIsAdmin = true;
    expect((await callPOST()).status).toBe(500);
  });

  it("triggers the x-dm-poll cron with Bearer CRON_SECRET", async () => {
    mockIsAdmin = true;
    process.env.CRON_SECRET = "secret";
    const fetchMock = mockFetch(true, 200, { polled: 2, new_dms: 1, replied: 1, errors: 0 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST();
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain("/api/x-dm-poll");
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer secret");

    const body = (await res.json()) as { triggered: boolean; result: { polled: number } };
    expect(body.triggered).toBe(true);
    expect(body.result.polled).toBe(2);
  });

  it("reports triggered:false when upstream returns non-2xx", async () => {
    mockIsAdmin = true;
    process.env.CRON_SECRET = "secret";
    vi.stubGlobal("fetch", mockFetch(false, 500, { error: "down" }));

    const res = await callPOST();
    const body = (await res.json()) as { triggered: boolean; status: number };
    expect(body.triggered).toBe(false);
    expect(body.status).toBe(500);
  });
});
