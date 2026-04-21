import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function call(query: string, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/content/status${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

describe("GET /api/content/status", () => {
  it("401 when not admin", async () => {
    expect((await call("?job_id=x", false)).status).toBe(401);
  });

  it("400 when job_id missing", async () => {
    expect((await call("")).status).toBe(400);
  });

  it("404 when job not found", async () => {
    fake.results.push([]);
    expect((await call("?job_id=missing")).status).toBe(404);
  });

  it("returns job row when found", async () => {
    fake.results.push([
      { id: "j-1", type: "image", status: "completed", result_url: "https://x" },
    ]);
    const res = await call("?job_id=j-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string; status: string } };
    expect(body.job.id).toBe("j-1");
    expect(body.job.status).toBe("completed");
  });
});
