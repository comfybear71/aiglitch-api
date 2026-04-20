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

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/activity-throttle${query}`));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/activity-throttle", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("GET /api/activity-throttle", () => {
  it("returns default throttle (100) when no row exists", async () => {
    fake.results = [[]];
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { throttle: number };
    expect(body.throttle).toBe(100);
  });

  it("returns stored throttle value", async () => {
    fake.results = [[{ value: "42" }]];
    const res = await callGET();
    const body = (await res.json()) as { throttle: number };
    expect(body.throttle).toBe(42);
  });

  it("returns job_states map when ?action=job_states", async () => {
    fake.results = [
      [{ value: "80" }],
      [
        { key: "cron_paused_x-react", value: "true" },
        { key: "cron_paused_sponsor-burn", value: "false" },
      ],
    ];
    const res = await callGET("?action=job_states");
    const body = (await res.json()) as { throttle: number; jobStates: Record<string, boolean> };
    expect(body.throttle).toBe(80);
    expect(body.jobStates).toEqual({ "x-react": true, "sponsor-burn": false });
  });
});

describe("POST /api/activity-throttle", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ throttle: 50 })).status).toBe(401);
  });

  it("upserts throttle value when admin, clamping to 0-100", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await callPOST({ throttle: 150 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { throttle: number };
    expect(body.throttle).toBe(100);
  });

  it("coerces negative throttle to 0", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await callPOST({ throttle: -10 });
    const body = (await res.json()) as { throttle: number };
    expect(body.throttle).toBe(0);
  });

  it("toggle_job flips from false to true when value does not exist", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // SELECT — no existing row
      [],  // INSERT/UPSERT
    ];
    const res = await callPOST({ action: "toggle_job", job_name: "x-react" });
    const body = (await res.json()) as { job: string; paused: boolean };
    expect(body).toEqual({ job: "x-react", paused: true });
  });

  it("toggle_job flips from true to false when currently paused", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ value: "true" }],  // SELECT — paused
      [],                    // UPSERT
    ];
    const res = await callPOST({ action: "toggle_job", job_name: "x-react" });
    const body = (await res.json()) as { paused: boolean };
    expect(body.paused).toBe(false);
  });

  it("toggle_job rejects missing job_name", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ action: "toggle_job" });
    expect(res.status).toBe(400);
  });
});
