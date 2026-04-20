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

// Swap the whole reaction cycle — route is a thin wrapper, so route tests
// only need to verify auth + passthrough.
const cycleMock = vi.fn();
vi.mock("@/lib/x-monitor", () => ({
  runXReactionCycle: () => cycleMock(),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  cycleMock.mockReset();
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
  return GET(new NextRequest("http://localhost/api/x-react", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}

async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/x-react", { method: "POST" }));
}

describe("GET /api/x-react", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("401 with wrong token", async () => {
    expect((await callGET("Bearer wrong")).status).toBe(401);
  });

  it("returns cycle summary on happy path (no tweets)", async () => {
    cycleMock.mockResolvedValue({
      tweetsProcessed: 0,
      reactionsCreated: 0,
      xRepliesSent: 0,
      results: [],
    });
    // cron_runs CREATE + INSERT + UPDATE
    fake.results = [[], [], []];

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tweetsProcessed: number;
      reactionsCreated: number;
      xRepliesSent: number;
      details: unknown[];
      _cron_run_id: string;
    };
    expect(body.tweetsProcessed).toBe(0);
    expect(body.reactionsCreated).toBe(0);
    expect(body.xRepliesSent).toBe(0);
    expect(body.details).toEqual([]);
    expect(typeof body._cron_run_id).toBe("string");
  });

  it("summarises reaction details including repliedOnX marker", async () => {
    cycleMock.mockResolvedValue({
      tweetsProcessed: 1,
      reactionsCreated: 2,
      xRepliesSent: 1,
      results: [{
        tweetId: "tw-1",
        tweetText: "Just sent Grok 7 to production",
        authorUsername: "elonmusk",
        reactions: [
          { persona: "techno_king", postId: "p-1", repliedOnX: true },
          { persona: "gigabrain_9000", postId: "p-2", repliedOnX: false },
        ],
      }],
    });
    fake.results = [[], [], []];

    const res = await callGET("Bearer secret");
    const body = (await res.json()) as {
      details: { tweet: string; personas: string[] }[];
    };
    expect(body.details[0].tweet).toBe('@elonmusk: "Just sent Grok 7 to production"');
    expect(body.details[0].personas).toEqual(["@techno_king (+ X reply)", "@gigabrain_9000"]);
  });

  it("returns 500 when cycle throws", async () => {
    cycleMock.mockRejectedValue(new Error("boom"));
    fake.results = [[], [], []];
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(500);
  });
});

describe("POST /api/x-react", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin and returns summary", async () => {
    mockIsAdmin = true;
    cycleMock.mockResolvedValue({
      tweetsProcessed: 0,
      reactionsCreated: 0,
      xRepliesSent: 0,
      results: [],
    });
    const res = await callPOST();
    expect(res.status).toBe(200);
    expect(cycleMock).toHaveBeenCalledOnce();
  });
});
