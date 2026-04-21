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

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  opts: { query?: string; body?: unknown } = {},
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/sponsors${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  switch (method) {
    case "GET":    return mod.GET(req);
    case "POST":   return mod.POST(req);
    case "PUT":    return mod.PUT(req);
    case "DELETE": return mod.DELETE(req);
  }
}

describe("GET /api/admin/sponsors", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns all sponsors when no status filter", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // CREATE TABLE
      [{ id: 1, company_name: "Acme" }, { id: 2, company_name: "Beta" }],
    ];
    const res = await call("GET");
    const body = (await res.json()) as { sponsors: unknown[] };
    expect(body.sponsors).toHaveLength(2);
  });

  it("filters by status when ?status= provided", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],
      [{ id: 1, status: "active" }],
    ];
    const res = await call("GET", { query: "?status=active" });
    expect(res.status).toBe(200);
    const statusedCall = fake.calls[1];
    expect(statusedCall.values[0]).toBe("active");
  });
});

describe("POST /api/admin/sponsors", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { body: { company_name: "x", contact_email: "y" } })).status).toBe(401);
  });

  it("400 when company_name or contact_email missing", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { body: { company_name: "x" } })).status).toBe(400);
    expect((await call("POST", { body: { contact_email: "y@z" } })).status).toBe(400);
  });

  it("inserts and returns the new id", async () => {
    mockIsAdmin = true;
    fake.results = [[], [{ id: 7 }]];
    const res = await call("POST", {
      body: { company_name: "Acme", contact_email: "hi@acme.co" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body).toEqual({ ok: true, id: 7 });
  });
});

describe("PUT /api/admin/sponsors", () => {
  it("401 when not admin", async () => {
    expect((await call("PUT", { body: { id: 1 } })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    expect((await call("PUT", { body: {} })).status).toBe(400);
  });

  it("updates and returns ok:true", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    const res = await call("PUT", { body: { id: 1, status: "active" } });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/sponsors", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", { query: "?id=1" })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    expect((await call("DELETE")).status).toBe(400);
  });

  it("400 when id is non-numeric", async () => {
    mockIsAdmin = true;
    expect((await call("DELETE", { query: "?id=abc" })).status).toBe(400);
  });

  it("hard-deletes by id", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    const res = await call("DELETE", { query: "?id=42" });
    expect(res.status).toBe(200);
    expect(fake.calls[1].strings.join("?")).toContain("DELETE FROM sponsors");
    expect(fake.calls[1].values[0]).toBe(42);
  });
});
