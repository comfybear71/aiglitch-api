/**
 * Integration tests for POST /api/suggest-feature.
 *
 * - 400 when title missing / whitespace-only
 * - Truncates title to 100 chars, description to 2000
 * - Default category "feature-request" when omitted
 * - When GITHUB_TOKEN set: calls GitHub Issues API; returns
 *   issue_number + issue_url on success
 * - When GITHUB_TOKEN set but API fails: falls through to DB insert
 * - When GITHUB_TOKEN missing: skips GitHub call, goes straight to DB
 * - DB insert errors are swallowed (legacy treats this best-effort)
 * - Always returns 200 with {success: true, message} on any non-title path
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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnNextCall = null;
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.GITHUB_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;
});

async function callPost(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/suggest-feature", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function mockFetch(
  response:
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; status: number; text: string },
) {
  globalThis.fetch = vi.fn(async () => {
    if (response.ok) {
      return new Response(JSON.stringify(response.body), { status: 200 });
    }
    return new Response(response.text, { status: response.status });
  }) as typeof globalThis.fetch;
}

describe("POST /api/suggest-feature", () => {
  it("400 when title missing", async () => {
    const res = await callPost({ description: "nothing" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing title");
  });

  it("400 when title is whitespace only", async () => {
    const res = await callPost({ title: "   " });
    expect(res.status).toBe(400);
  });

  it("GITHUB_TOKEN missing → skips fetch, does DB INSERT, returns generic success", async () => {
    fake.results = [[]]; // INSERT
    globalThis.fetch = vi.fn(() => {
      throw new Error("fetch should not be called");
    }) as typeof globalThis.fetch;
    const res = await callPost({
      title: "Add dark mode",
      description: "at night my eyes hurt",
      session_id: "user-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      message: string;
      issue_number?: number;
    };
    expect(body.success).toBe(true);
    expect(body.issue_number).toBeUndefined();

    const sql = fake.calls[0]!.strings.join("?");
    expect(sql).toContain("INSERT INTO feature_suggestions");
    expect(fake.calls[0]!.values).toContain("Add dark mode");
    expect(fake.calls[0]!.values).toContain("at night my eyes hurt");
    expect(fake.calls[0]!.values).toContain("user-1");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("GITHUB_TOKEN set + API success → returns issue_number + issue_url, no DB INSERT", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    mockFetch({
      ok: true,
      body: { number: 42, html_url: "https://github.com/comfybear71/aiglitch/issues/42" },
    });
    const res = await callPost({ title: "Add dark mode" });
    const body = (await res.json()) as {
      success: boolean;
      issue_number: number;
      issue_url: string;
    };
    expect(body.success).toBe(true);
    expect(body.issue_number).toBe(42);
    expect(body.issue_url).toBe("https://github.com/comfybear71/aiglitch/issues/42");
    // No DB fallback fired
    expect(fake.calls).toHaveLength(0);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/comfybear71/aiglitch/issues");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_test");
    const issuePayload = JSON.parse(init.body as string) as {
      title: string;
      labels: string[];
    };
    expect(issuePayload.title).toBe("[App Suggestion] Add dark mode");
    expect(issuePayload.labels).toContain("app-suggestion");
    expect(issuePayload.labels).toContain("feature-request"); // default category
  });

  it("GITHUB_TOKEN set + GitHub 4xx → falls through to DB INSERT + generic success", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    mockFetch({ ok: false, status: 403, text: "forbidden" });
    fake.results = [[]]; // INSERT
    const res = await callPost({ title: "Something" });
    const body = (await res.json()) as {
      success: boolean;
      issue_number?: number;
    };
    expect(body.success).toBe(true);
    expect(body.issue_number).toBeUndefined();
    expect(fake.calls).toHaveLength(1); // DB fallback fired
  });

  it("GITHUB_TOKEN set + fetch throws → falls through to DB INSERT + generic success", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;
    fake.results = [[]];
    const res = await callPost({ title: "Something" });
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("DB INSERT error is swallowed, still returns generic success", async () => {
    fake.throwOnNextCall = new Error("table not found");
    const res = await callPost({ title: "Something" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("truncates title to 100 chars and description to 2000 chars", async () => {
    fake.results = [[]];
    const longTitle = "a".repeat(500);
    const longDesc = "b".repeat(5000);
    await callPost({ title: longTitle, description: longDesc });
    const titleValue = fake.calls[0]!.values.find(
      (v) => typeof v === "string" && v.startsWith("a"),
    ) as string;
    const descValue = fake.calls[0]!.values.find(
      (v) => typeof v === "string" && v.startsWith("b"),
    ) as string;
    expect(titleValue.length).toBe(100);
    expect(descValue.length).toBe(2000);
  });

  it("default category is 'feature-request' when omitted", async () => {
    fake.results = [[]];
    await callPost({ title: "x" });
    expect(fake.calls[0]!.values).toContain("feature-request");
  });

  it("custom category is respected", async () => {
    fake.results = [[]];
    await callPost({ title: "x", category: "bug-report" });
    expect(fake.calls[0]!.values).toContain("bug-report");
  });
});
