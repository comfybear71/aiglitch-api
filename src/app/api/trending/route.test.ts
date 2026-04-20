/**
 * Integration tests for GET /api/trending.
 *
 * Catches:
 *   - Response shape { trending, hotPersonas }
 *   - SQL constants (trending hashtags limit 15, hot personas limit 5)
 *   - Time windows (7 days for hashtags, 24 hours for personas)
 *   - Cache-Control: public, s-maxage=60, SWR=300 (safe because non-personalised)
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

async function callGet() {
  vi.resetModules();
  const { GET } = await import("./route");
  return GET();
}

describe("GET /api/trending", () => {
  it("returns { trending, hotPersonas } shape", async () => {
    fake.results = [
      [{ tag: "AIGlitchBreaking", count: 42 }],
      [
        {
          id: "p1",
          username: "alice",
          display_name: "Alice",
          avatar_emoji: "🤖",
          persona_type: "general",
          recent_posts: 7,
        },
      ],
    ];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trending: Array<{ tag: string; count: number }>;
      hotPersonas: Array<{ id: string; recent_posts: number }>;
    };
    expect(Object.keys(body).sort()).toEqual(["hotPersonas", "trending"]);
    expect(body.trending[0]?.tag).toBe("AIGlitchBreaking");
    expect(body.trending[0]?.count).toBe(42);
    expect(body.hotPersonas[0]?.id).toBe("p1");
    expect(body.hotPersonas[0]?.recent_posts).toBe(7);
  });

  it("handles empty aggregates cleanly", async () => {
    fake.results = [[], []];
    const res = await callGet();
    const body = (await res.json()) as { trending: unknown[]; hotPersonas: unknown[] };
    expect(body.trending).toEqual([]);
    expect(body.hotPersonas).toEqual([]);
  });

  it("issues exactly two parallel queries", async () => {
    fake.results = [[], []];
    await callGet();
    expect(fake.calls).toHaveLength(2);
  });

  it("trending hashtags query limits to 15 and filters last 7 days", async () => {
    fake.results = [[], []];
    await callGet();
    const sqlText = fake.calls[0]!.strings.join("?");
    expect(sqlText).toContain("FROM post_hashtags");
    expect(sqlText).toContain("INTERVAL '7 days'");
    expect(fake.calls[0]!.values).toContain(15);
  });

  it("hot personas query limits to 5 and filters last 24 hours", async () => {
    fake.results = [[], []];
    await callGet();
    const sqlText = fake.calls[1]!.strings.join("?");
    expect(sqlText).toContain("JOIN posts p");
    expect(sqlText).toContain("INTERVAL '24 hours'");
    expect(sqlText).toContain("is_active = TRUE");
    expect(fake.calls[1]!.values).toContain(5);
  });

  it("sets Cache-Control: public, s-maxage=60, SWR=300 (safe because non-personalised)", async () => {
    fake.results = [[], []];
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
    expect(body.error).toBe("Failed to fetch trending");
    expect(body.detail).toBe("pg down");
  });
});
