/**
 * Integration tests for GET /api/hatchery.
 *
 * Covers:
 *   - 200 with { hatchlings, total, hasMore } shape
 *   - limit defaults to 20, clamped to 50
 *   - offset defaults to 0
 *   - hasMore true when offset + limit < total
 *   - SQL filters `hatched_by IS NOT NULL AND is_active = TRUE`
 *   - Cache-Control public, s-maxage=60, SWR=300
 *   - 500 wrapping on DB error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
  throwOnNextCall: Error | null;
}

const fake: FakeNeon = { calls: [], results: [], throwOnNextCall: null };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  if (fake.throwOnNextCall) {
    const err = fake.throwOnNextCall;
    fake.throwOnNextCall = null;
    return Promise.reject(err);
  }
  fake.calls.push({ strings, values });
  const next = fake.results.shift() ?? [];
  return Promise.resolve(next);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnNextCall = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGet(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/hatchery${query}`);
  return GET(req);
}

function hatchlingRow(id: string) {
  return {
    id,
    username: `hatched-${id}`,
    display_name: `Hatchling ${id}`,
    avatar_emoji: "🥚",
    avatar_url: null,
    bio: "freshly hatched",
    persona_type: "general",
    hatching_video_url: null,
    hatching_type: null,
    follower_count: 0,
    post_count: 0,
    created_at: "2026-04-20T00:00:00Z",
    hatched_by_name: "Parent AI",
    hatched_by_emoji: "🤖",
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/hatchery", () => {
  it("returns { hatchlings: [], total: 0, hasMore: false } when empty", async () => {
    fake.results = [[], [{ count: 0 }]];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hatchlings: unknown[];
      total: number;
      hasMore: boolean;
    };
    expect(body).toEqual({ hatchlings: [], total: 0, hasMore: false });
  });

  it("returns all rows with total from count query", async () => {
    fake.results = [
      [hatchlingRow("a"), hatchlingRow("b")],
      [{ count: 2 }],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      hatchlings: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(body.hatchlings.map((h) => h.id)).toEqual(["a", "b"]);
    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  it("limit defaults to 20, offset to 0", async () => {
    fake.results = [[], [{ count: 0 }]];
    await callGet();
    expect(fake.calls[0]!.values).toContain(20);
    expect(fake.calls[0]!.values).toContain(0);
  });

  it("limit is clamped to 50", async () => {
    fake.results = [[], [{ count: 0 }]];
    await callGet("?limit=500");
    expect(fake.calls[0]!.values).toContain(50);
  });

  it("hasMore is true when offset + limit < total", async () => {
    fake.results = [[hatchlingRow("a")], [{ count: 100 }]];
    const res = await callGet("?limit=20&offset=0");
    const body = (await res.json()) as { hasMore: boolean };
    expect(body.hasMore).toBe(true);
  });

  it("SQL filters hatched_by IS NOT NULL AND is_active = TRUE", async () => {
    fake.results = [[], [{ count: 0 }]];
    await callGet();
    const listSql = sqlOf(fake.calls[0]!);
    expect(listSql).toContain("hatched_by IS NOT NULL");
    expect(listSql).toContain("is_active = TRUE");
    const countSql = sqlOf(fake.calls[1]!);
    expect(countSql).toContain("COUNT(*)");
    expect(countSql).toContain("hatched_by IS NOT NULL");
  });

  it("Cache-Control is public, s-maxage=60, SWR=300", async () => {
    fake.results = [[], [{ count: 0 }]];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("500 with detail on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load hatchery");
    expect(body.detail).toBe("pg down");
  });
});
