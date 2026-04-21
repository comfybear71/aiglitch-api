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

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/personas", init);
  switch (method) {
    case "GET":    return mod.GET(req);
    case "POST":   return mod.POST(req);
    case "PATCH":  return mod.PATCH(req);
    case "DELETE": return mod.DELETE(req);
  }
}

describe("GET /api/admin/personas", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns enriched persona list", async () => {
    mockIsAdmin = true;
    fake.results = [[
      { id: "glitch-001", username: "alpha", actual_posts: 5, human_followers: 3, sol_balance: 1.5 },
      { id: "glitch-002", username: "beta", actual_posts: 0, human_followers: 0, sol_balance: 0 },
    ]];
    const res = await call("GET");
    const body = (await res.json()) as { personas: { id: string }[] };
    expect(body.personas).toHaveLength(2);
  });
});

describe("POST /api/admin/personas", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { username: "x", display_name: "X", personality: "p", bio: "b" })).status).toBe(401);
  });

  it("400 when required field missing", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { username: "x", display_name: "X" })).status).toBe(400);
  });

  it("creates persona with generated id on happy path", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("POST", {
      username: "new_bot",
      display_name: "New Bot",
      personality: "chaotic",
      bio: "fresh",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: string };
    expect(body.success).toBe(true);
    expect(body.id).toMatch(/^glitch-[a-f0-9]{8}$/);
  });
});

describe("PATCH /api/admin/personas", () => {
  it("401 when not admin", async () => {
    expect((await call("PATCH", { id: "x" })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    expect((await call("PATCH", {})).status).toBe(400);
  });

  it("only writes fields that are provided", async () => {
    mockIsAdmin = true;
    fake.results = [[], []]; // two updates
    const res = await call("PATCH", {
      id: "glitch-001",
      display_name: "Renamed",
      is_active: false,
    });
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(2);
  });

  it("skips activity_level if out of 1-10 range", async () => {
    mockIsAdmin = true;
    // no SQL calls expected — only id check passes, invalid activity_level is skipped
    await call("PATCH", { id: "glitch-001", activity_level: 99 });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("DELETE /api/admin/personas", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", { id: "x" })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    expect((await call("DELETE", {})).status).toBe(400);
  });

  it("soft-deletes by setting is_active=FALSE", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("DELETE", { id: "glitch-001" });
    expect(res.status).toBe(200);
    const sql = fake.calls[0].strings.join("?");
    expect(sql).toContain("UPDATE ai_personas");
    expect(sql).toContain("is_active = FALSE");
    expect(fake.calls[0].values[0]).toBe("glitch-001");
  });
});
