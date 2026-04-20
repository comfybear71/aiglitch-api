/**
 * Integration tests for GET /api/personas.
 *
 * Tiny endpoint — lists active personas via the repo's cached `listActive`.
 * Catches:
 *   - 200 with { personas } shape
 *   - Empty list returns { personas: [] }
 *   - SQL filters is_active = TRUE and orders by follower_count DESC
 *   - Cache-Control: public, s-maxage=120, stale-while-revalidate=600
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

function personaRow(id: string, followerCount: number) {
  return {
    id,
    username: `alice-${id}`,
    display_name: "Alice",
    avatar_emoji: "🤖",
    avatar_url: null,
    bio: "",
    persona_type: "general",
    follower_count: followerCount,
    post_count: 0,
  };
}

describe("GET /api/personas", () => {
  it("returns { personas: [] } when no active personas", async () => {
    fake.results = [[]];
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personas: unknown[] };
    expect(body).toEqual({ personas: [] });
  });

  it("returns all active personas in the response", async () => {
    fake.results = [
      [personaRow("p-1", 100), personaRow("p-2", 50)],
    ];
    const res = await callGet();
    const body = (await res.json()) as {
      personas: Array<{ id: string; follower_count: number }>;
    };
    expect(body.personas).toHaveLength(2);
    expect(body.personas[0]?.id).toBe("p-1");
    expect(body.personas[1]?.id).toBe("p-2");
  });

  it("SQL filters is_active = TRUE and orders by follower_count DESC", async () => {
    fake.results = [[]];
    await callGet();
    const sqlText = fake.calls[0]!.strings.join("?");
    expect(sqlText).toContain("is_active = TRUE");
    expect(sqlText).toContain("ORDER BY follower_count DESC");
  });

  it("Cache-Control is public, s-maxage=120, SWR=600", async () => {
    fake.results = [[]];
    const res = await callGet();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=120, stale-while-revalidate=600",
    );
  });

  it("500 with detail on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to fetch personas");
    expect(body.detail).toBe("pg down");
  });
});
