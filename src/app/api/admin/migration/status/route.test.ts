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

  it("summary splits pending into to_port + to_delete + permanent buckets", async () => {
    const res = await call();
    const body = (await res.json()) as {
      pending: { blocker: string }[];
      summary: {
        ported_count: number;
        pending_count: number;
        to_port_count: number;
        to_delete_count: number;
        permanent_count: number;
        portable_total: number;
        percent_done: number;
      };
    };
    expect(body.summary.to_delete_count).toBe(
      body.pending.filter((r) => r.blocker === "dead-code").length,
    );
    expect(body.summary.permanent_count).toBe(
      body.pending.filter((r) => r.blocker === "permanent-legacy").length,
    );
    expect(
      body.summary.to_port_count +
        body.summary.to_delete_count +
        body.summary.permanent_count,
    ).toBe(body.summary.pending_count);
    expect(body.summary.portable_total).toBe(
      body.summary.ported_count + body.summary.to_port_count,
    );
    // percent_done is based on portable routes only, ignoring dead-code +
    // permanent-legacy entries. Today's state: 100% (no real to-port left).
    expect(body.summary.percent_done).toBe(
      body.summary.portable_total === 0
        ? 100
        : Math.round((body.summary.ported_count / body.summary.portable_total) * 1000) / 10,
    );
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
