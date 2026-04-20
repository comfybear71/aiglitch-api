import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const runFeedbackMock = vi.fn();
vi.mock("@/lib/content/feedback-loop", () => ({
  runFeedbackLoop: () => runFeedbackMock(),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  runFeedbackMock.mockReset();
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
  return GET(new NextRequest("http://localhost/api/feedback-loop", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}

async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/feedback-loop", { method: "POST" }));
}

describe("GET /api/feedback-loop", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("401 with wrong token", async () => {
    expect((await callGET("Bearer wrong")).status).toBe(401);
  });

  it("returns feedback-loop result wrapped in cron run id", async () => {
    runFeedbackMock.mockResolvedValue({
      channelsUpdated: 2,
      channelsSkipped: 1,
      details: [{ channel: "tech", avgScore: 2.5, totalReactions: 30, hint: "lean into hot takes" }],
    });
    fake.results = [[], [], []];

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channelsUpdated: number;
      channelsSkipped: number;
      details: unknown[];
      _cron_run_id: string;
    };
    expect(body.channelsUpdated).toBe(2);
    expect(body.channelsSkipped).toBe(1);
    expect(body.details).toHaveLength(1);
    expect(typeof body._cron_run_id).toBe("string");
  });

  it("returns 500 when runner throws", async () => {
    runFeedbackMock.mockRejectedValue(new Error("boom"));
    fake.results = [[], [], []];
    expect((await callGET("Bearer secret")).status).toBe(500);
  });
});

describe("POST /api/feedback-loop", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin", async () => {
    mockIsAdmin = true;
    runFeedbackMock.mockResolvedValue({ channelsUpdated: 0, channelsSkipped: 0, details: [] });
    const res = await callPOST();
    expect(res.status).toBe(200);
    expect(runFeedbackMock).toHaveBeenCalledOnce();
  });
});
