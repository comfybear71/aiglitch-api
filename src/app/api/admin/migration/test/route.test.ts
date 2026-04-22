import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as (RowSet | Error)[] };
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const fetchMock = vi.fn();

beforeEach(async () => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.DATABASE_URL = "postgres://test";
  process.env.NEXT_PUBLIC_APP_URL = "https://api.aiglitch.app";
  vi.resetModules();
  const mod = await import("@/lib/migration/request-log");
  mod.__resetRequestLogTableFlag();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  vi.restoreAllMocks();
});

async function call(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/migration/test", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", cookie: "admin=abc" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

function seedTableCreate() {
  fake.results.push([]); // CREATE TABLE
  fake.results.push([]); // INDEX
  fake.results.push([]); // INDEX
}

describe("POST /api/admin/migration/test", () => {
  it("401 when not admin", async () => {
    expect((await call({ path: "/api/x" }, false)).status).toBe(401);
  });

  it("400 when path missing", async () => {
    expect((await call({})).status).toBe(400);
  });

  it("400 when path is not absolute", async () => {
    expect((await call({ path: "api/x" })).status).toBe(400);
  });

  it("400 when method is disallowed", async () => {
    expect((await call({ path: "/api/x", method: "OPTIONS" })).status).toBe(400);
  });

  it("happy GET: forwards admin cookie, logs, returns body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    seedTableCreate();
    fake.results.push([]); // INSERT log

    const res = await call({ path: "/api/personas" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: number;
      body: { hello: string };
      log_id: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(body.body.hello).toBe("world");
    expect(body.log_id).toBeTruthy();

    // Verify the inner fetch sent the admin cookie along
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.aiglitch.app/api/personas");
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs.cookie).toBe("admin=abc");
  });

  it("POST with body serialises as JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    seedTableCreate();
    fake.results.push([]); // INSERT

    await call({
      path: "/api/interact",
      method: "POST",
      body: { action: "like", post_id: "p1" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(
      JSON.stringify({ action: "like", post_id: "p1" }),
    );
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs["content-type"]).toBe("application/json");
  });

  it("query params appended to URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    seedTableCreate();
    fake.results.push([]);
    await call({
      path: "/api/feed",
      query: { limit: "10", session_id: "s1" },
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("limit=10");
    expect(url).toContain("session_id=s1");
  });

  it("network error is captured, returns ok:false", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    seedTableCreate();
    fake.results.push([]); // INSERT still fires with error

    const res = await call({ path: "/api/x" });
    const body = (await res.json()) as {
      ok: boolean;
      status: number | null;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.status).toBeNull();
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("4xx response marks ok:false even without network error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    seedTableCreate();
    fake.results.push([]);
    const res = await call({ path: "/api/missing" });
    const body = (await res.json()) as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
  });

  it("non-JSON response body is returned as string", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("plain text response", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    seedTableCreate();
    fake.results.push([]);
    const res = await call({ path: "/api/x" });
    const body = (await res.json()) as { body: string };
    expect(body.body).toBe("plain text response");
  });

  it("logging failure doesn't blow up the response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    // table create succeeds, but INSERT throws — request still returns body
    seedTableCreate();
    fake.results.push(new Error("log insert failed"));
    const res = await call({ path: "/api/x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; log_id: string | null };
    expect(body.ok).toBe(true);
    expect(body.log_id).toBeNull();
  });
});
