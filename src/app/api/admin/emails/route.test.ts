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
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
});

async function call(method: "GET" | "POST", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/emails${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/emails", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("global log when no persona_id provided", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // CREATE TABLE
      [{ id: "e1", subject: "hi" }, { id: "e2", subject: "hey" }],
    ];
    const res = await call("GET");
    const body = (await res.json()) as { total: number; emails: unknown[] };
    expect(body.total).toBe(2);
  });

  it("per-persona log when persona_id provided", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    await call("GET", { query: "?persona_id=glitch-001" });
    const selectCall = fake.calls[1];
    expect(selectCall.values).toContain("glitch-001");
  });

  it("clamps limit at 500", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    await call("GET", { query: "?limit=9999" });
    const selectCall = fake.calls[1];
    expect(selectCall.values).toContain(500);
  });
});

describe("POST /api/admin/emails — validation", () => {
  beforeEach(() => { mockIsAdmin = true; });

  it("401 when not admin", async () => {
    mockIsAdmin = false;
    expect((await call("POST", { body: { persona_id: "p1", to: "a@b.co", subject: "s", body: "b" } })).status).toBe(401);
  });

  it("400 when any required field missing", async () => {
    fake.results = [[]];
    expect((await call("POST", { body: {} })).status).toBe(400);
    fake.results = [[]];
    expect((await call("POST", { body: { persona_id: "p1" } })).status).toBe(400);
    fake.results = [[]];
    expect((await call("POST", { body: { persona_id: "p1", to: "a@b.co" } })).status).toBe(400);
    fake.results = [[]];
    expect((await call("POST", { body: { persona_id: "p1", to: "a@b.co", subject: "s" } })).status).toBe(400);
  });

  it("400 when to is not a valid email", async () => {
    fake.results = [[]];
    const res = await call("POST", { body: { persona_id: "p1", to: "not-email", subject: "s", body: "b" } });
    expect(res.status).toBe(400);
  });

  it("500 when RESEND_API_KEY not configured", async () => {
    fake.results = [[]];
    const res = await call("POST", { body: { persona_id: "p1", to: "a@b.co", subject: "s", body: "b" } });
    expect(res.status).toBe(500);
  });

  it("404 when persona not found or inactive", async () => {
    process.env.RESEND_API_KEY = "rk-test";
    fake.results = [[], []];  // CREATE + SELECT persona empty
    const res = await call("POST", { body: { persona_id: "missing", to: "a@b.co", subject: "s", body: "b" } });
    expect(res.status).toBe(404);
  });

  it("429 when rate limit (3/hr) exceeded", async () => {
    process.env.RESEND_API_KEY = "rk-test";
    fake.results = [
      [],                                                      // CREATE TABLE
      [{ id: "p1", username: "alpha", display_name: "Alpha" }], // persona
      [{ c: 3 }],                                              // rate check — already 3
    ];
    const res = await call("POST", { body: { persona_id: "p1", to: "a@b.co", subject: "s", body: "b" } });
    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/emails — send flow", () => {
  beforeEach(() => {
    mockIsAdmin = true;
    process.env.RESEND_API_KEY = "rk-test";
  });

  it("sends via Resend and logs success", async () => {
    vi.stubGlobal("fetch", mockFetch(true, 200, { id: "rs-abc" }));
    fake.results = [
      [],  // CREATE
      [{ id: "p1", username: "alpha", display_name: "Alpha" }],
      [{ c: 0 }],
      [],  // INSERT email_sends
    ];
    const res = await call("POST", {
      body: { persona_id: "p1", to: "a@b.co", subject: "hello", body: "world" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; resend_id: string; from: string };
    expect(body.success).toBe(true);
    expect(body.resend_id).toBe("rs-abc");
    expect(body.from).toBe("alpha@aiglitch.app");
  });

  it("502 + logs failure when Resend returns non-ok", async () => {
    vi.stubGlobal("fetch", mockFetch(false, 400, { message: "Invalid from" }));
    fake.results = [
      [],
      [{ id: "p1", username: "alpha", display_name: "Alpha" }],
      [{ c: 0 }],
      [],  // INSERT (status=failed)
    ];
    const res = await call("POST", {
      body: { persona_id: "p1", to: "a@b.co", subject: "hello", body: "world" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { success: boolean; status: string };
    expect(body.success).toBe(false);
    expect(body.status).toBe("failed");
  });

  it("502 when Resend fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    fake.results = [
      [],
      [{ id: "p1", username: "alpha", display_name: "Alpha" }],
      [{ c: 0 }],
      [],
    ];
    const res = await call("POST", {
      body: { persona_id: "p1", to: "a@b.co", subject: "hello", body: "world" },
    });
    expect(res.status).toBe(502);
  });
});
