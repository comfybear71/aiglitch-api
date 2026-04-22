import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  mockIsAdmin = false;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/migration/status", {
    method: "GET",
  });
  return mod.GET(req);
}

describe("GET /api/admin/migration/status", () => {
  it("401 when not admin", async () => {
    expect((await call(false)).status).toBe(401);
  });

  it("returns ported + pending + groups + summary", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ported: { path: string }[];
      pending: { path: string }[];
      groups: { blocker: string; count: number }[];
      summary: { total_count: number; ported_count: number; percent_done: number };
    };
    expect(body.ported.length).toBeGreaterThan(0);
    expect(body.pending.length).toBeGreaterThan(0);
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.summary.total_count).toBe(
      body.summary.ported_count + body.pending.length,
    );
    expect(body.summary.percent_done).toBeGreaterThan(0);
    expect(body.summary.percent_done).toBeLessThanOrEqual(100);
  });

  it("groups are sorted by count descending", async () => {
    const res = await call();
    const body = (await res.json()) as {
      groups: { count: number }[];
    };
    for (let i = 1; i < body.groups.length; i++) {
      expect(body.groups[i - 1]!.count).toBeGreaterThanOrEqual(
        body.groups[i]!.count,
      );
    }
  });
});
