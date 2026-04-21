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

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/contacts${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  switch (method) {
    case "GET":    return mod.GET(req);
    case "POST":   return mod.POST(req);
    case "PATCH":  return mod.PATCH(req);
    case "DELETE": return mod.DELETE(req);
  }
}

describe("GET /api/admin/contacts", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns all contacts when no filter provided", async () => {
    mockIsAdmin = true;
    fake.results = [
      [], [],  // CREATE TABLE + unique index
      [
        { id: "c1", email: "a@b.com", tags: ["media"] },
        { id: "c2", email: "c@d.com", tags: ["sponsors", "journalists"] },
      ],
    ];
    const res = await call("GET");
    const body = (await res.json()) as {
      total: number;
      contacts: unknown[];
      all_tags: string[];
    };
    expect(body.total).toBe(2);
    expect(body.all_tags).toEqual(["journalists", "media", "sponsors"]);
  });

  it("filters by tag via @> operator", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    await call("GET", { query: "?tag=media" });
    const selectCall = fake.calls[2];
    expect(selectCall.strings.join("?")).toContain("c.tags @> ");
  });

  it("filters by assigned_persona_id", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    await call("GET", { query: "?assigned_persona_id=glitch-001" });
    const selectCall = fake.calls[2];
    expect(selectCall.values).toContain("glitch-001");
  });
});

describe("POST /api/admin/contacts — single mode", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { body: { email: "a@b.com" } })).status).toBe(401);
  });

  it("400 on invalid email", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("POST", { body: { email: "not-an-email" } })).status).toBe(400);
  });

  it("inserts and returns new id", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    const res = await call("POST", { body: { email: "a@b.com", name: "Alice", tags: ["media"] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: string };
    expect(body.success).toBe(true);
    expect(body.id).toBeTruthy();
  });

  it("409 on duplicate email", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], new Error("duplicate key value violates unique constraint")];
    const res = await call("POST", { body: { email: "a@b.com" } });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/contacts — bulk mode", () => {
  it("imports multiple lines, skips invalid emails", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],  // CREATE TABLE
      [],  // index
      [{ id: "id1" }],  // line 1 inserted
      [],  // line 2 (invalid, no SQL)? no — invalid lines skip before SQL
      [{ id: "id2" }],  // line 3 inserted
      [],  // line 4 (conflict, RETURNING empty)
    ];
    const csv = [
      "a@b.com, Alice, Acme",
      "not-an-email",
      "c@d.com, Carol",
      "existing@dup.com, Dan",
    ].join("\n");
    const res = await call("POST", { body: { bulk: csv, default_tags: ["sponsors"] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      created: number;
      skipped: number;
      errors_count: number;
    };
    expect(body.mode).toBe("bulk");
    expect(body.created).toBe(2);        // id1, id2
    expect(body.skipped).toBe(1);        // existing@dup.com (empty RETURNING)
    expect(body.errors_count).toBe(1);   // not-an-email
  });
});

describe("PATCH /api/admin/contacts", () => {
  it("401 when not admin", async () => {
    expect((await call("PATCH", { body: { id: "x" } })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("PATCH", { body: { name: "x" } })).status).toBe(400);
  });

  it("400 when email format invalid", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("PATCH", { body: { id: "c1", email: "bad" } })).status).toBe(400);
  });

  it("updates and returns success", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    const res = await call("PATCH", { body: { id: "c1", name: "New Name" } });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/contacts", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", { query: "?id=c1" })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    expect((await call("DELETE")).status).toBe(400);
  });

  it("deletes by id", async () => {
    mockIsAdmin = true;
    fake.results = [[], [], []];
    const res = await call("DELETE", { query: "?id=c1" });
    expect(res.status).toBe(200);
    const del = fake.calls[2];
    expect(del.strings.join("?")).toContain("DELETE FROM contacts");
    expect(del.values).toContain("c1");
  });
});
