/**
 * Tests for src/middleware.ts — the live-traffic request logger.
 *
 * Focus is on the routing/dispatch logic rather than the DB insert
 * itself (which is exercised end-to-end via the existing request-log
 * suite). We assert:
 *   • /api/admin/migration/* paths are skipped (no recursion)
 *   • /api/* paths pass through and trigger the logger
 *   • The logger never throws back into the request pipeline
 *   • Missing DATABASE_URL silently no-ops
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every neon-client call so we can assert it fired (or didn't).
const sqlMock = vi.fn(async () => [] as unknown[]);
const neonMock = vi.fn(() => sqlMock);

vi.mock("@neondatabase/serverless", () => ({
  neon: neonMock,
}));

beforeEach(() => {
  sqlMock.mockClear();
  neonMock.mockClear();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callMiddleware(path: string, method = "GET") {
  vi.resetModules();
  const { middleware } = await import("./middleware");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost${path}`, { method });
  return middleware(req);
}

// Wait for the fire-and-forget insert to settle before assertions.
function flushMicrotasks() {
  return new Promise<void>((r) => setImmediate(r));
}

describe("middleware — live request logger", () => {
  it("passes through and logs an /api/* request", async () => {
    const res = await callMiddleware("/api/channels/feed");
    expect(res.status).toBe(200); // NextResponse.next() default
    await flushMicrotasks();

    expect(neonMock).toHaveBeenCalledTimes(1);
    expect(sqlMock).toHaveBeenCalled();
  });

  it("skips /api/admin/migration/* to avoid recursion + spam", async () => {
    const res = await callMiddleware("/api/admin/migration/log");
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(neonMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("skips /api/admin/migration/metrics specifically (sub-path)", async () => {
    await callMiddleware("/api/admin/migration/metrics");
    await flushMicrotasks();
    expect(neonMock).not.toHaveBeenCalled();
  });

  it("does NOT skip /api/admin/users (admin but NOT migration)", async () => {
    await callMiddleware("/api/admin/users");
    await flushMicrotasks();
    expect(neonMock).toHaveBeenCalledTimes(1);
  });

  it("silently no-ops when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const res = await callMiddleware("/api/feed");
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(neonMock).not.toHaveBeenCalled();
  });

  it("never throws when neon() throws", async () => {
    neonMock.mockImplementationOnce(() => {
      throw new Error("neon connect failed");
    });
    // Should NOT throw — middleware swallows logger errors.
    const res = await callMiddleware("/api/feed");
    expect(res.status).toBe(200);
  });

  it("never throws when the insert query rejects", async () => {
    sqlMock.mockRejectedValueOnce(new Error("insert failed"));
    const res = await callMiddleware("/api/feed");
    expect(res.status).toBe(200);
    await flushMicrotasks();
    // Logger swallowed the error; request still proceeded.
  });
});
