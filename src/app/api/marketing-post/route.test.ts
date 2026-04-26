import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runMarketingCycleMock = vi.fn();
vi.mock("@/lib/marketing", () => ({
  runMarketingCycle: () => runMarketingCycleMock(),
}));

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.results = [];
  runMarketingCycleMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

async function callGET(authHeader?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = authHeader
    ? { authorization: authHeader }
    : {};
  return GET(
    new NextRequest("http://localhost/api/marketing-post", {
      headers: new Headers(headers),
    }),
  );
}

describe("GET /api/marketing-post", () => {
  it("401 without cron auth", async () => {
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("200 with valid cron auth and returns the cycle result", async () => {
    runMarketingCycleMock.mockResolvedValue({
      posted: 2,
      failed: 0,
      skipped: 0,
      details: [],
    });
    fake.results = [[], [], []]; // cron_runs ensure + insert + update

    const res = await callGET("Bearer test-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posted: number; _cron_run_id: string };
    expect(body.posted).toBe(2);
    expect(typeof body._cron_run_id).toBe("string");
  });

  it("500 when runMarketingCycle throws", async () => {
    runMarketingCycleMock.mockRejectedValue(new Error("db down"));
    fake.results = [[], [], []];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callGET("Bearer test-secret");
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});
