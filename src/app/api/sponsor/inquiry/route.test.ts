/**
 * Integration tests for POST /api/sponsor/inquiry.
 *
 * - 429 once the same IP hits 5 submissions in the rolling hour
 * - 400 missing company_name / contact_email / message < 10 / bad email
 * - 200 happy path: INSERTs into sponsors with status='inquiry'
 * - notes column concatenates message + optional preferred_package line
 * - 500 wrapping on DB error
 * - Uses x-forwarded-for first IP for rate-limit keying
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

async function callPost(body: unknown, ip = "1.2.3.4") {
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/sponsor/inquiry", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
  });
  return POST(req);
}

/**
 * Reset the module-level rate-limit Map between tests. Exported test
 * helper lives on the route module; re-imports don't re-init the Map
 * because of module caching without resetModules — which is exactly
 * what we need for the one rate-limit test but want to undo for all others.
 */
async function resetRateLimit() {
  const mod = await import("./route");
  (mod as unknown as { __resetRateLimit: () => void }).__resetRateLimit();
}

function validInquiry(overrides: Record<string, unknown> = {}) {
  return {
    company_name: "ACME Corp",
    contact_email: "test@example.com",
    contact_name: "Stuie",
    industry: "Widgets",
    website: "https://acme.example",
    message: "We would like to sponsor your platform.",
    preferred_package: "Gold",
    ...overrides,
  };
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("POST /api/sponsor/inquiry", () => {
  beforeEach(async () => {
    await resetRateLimit();
  });

  it("400 when company_name missing", async () => {
    const res = await callPost(validInquiry({ company_name: undefined }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("required");
  });

  it("400 when contact_email missing", async () => {
    const res = await callPost(validInquiry({ contact_email: undefined }));
    expect(res.status).toBe(400);
  });

  it("400 when message too short", async () => {
    const res = await callPost(validInquiry({ message: "hi" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("10");
  });

  it("400 on invalid email (no @)", async () => {
    const res = await callPost(validInquiry({ contact_email: "no-at-symbol.com" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid email format");
  });

  it("400 on invalid email (no dot)", async () => {
    const res = await callPost(validInquiry({ contact_email: "test@nodotcom" }));
    expect(res.status).toBe(400);
  });

  it("happy path: 200 + INSERTs sponsors with status='inquiry'", async () => {
    fake.results = [[]]; // INSERT
    const res = await callPost(validInquiry());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);

    const sql = sqlOf(fake.calls[0]!);
    expect(sql).toContain("INSERT INTO sponsors");
    expect(sql).toContain("'inquiry'");
    expect(fake.calls[0]!.values).toContain("ACME Corp");
    expect(fake.calls[0]!.values).toContain("test@example.com");
    expect(fake.calls[0]!.values).toContain("Stuie");
    expect(fake.calls[0]!.values).toContain("Widgets");
    expect(fake.calls[0]!.values).toContain("https://acme.example");
  });

  it("notes column concatenates message + 'Preferred package' line when provided", async () => {
    fake.results = [[]];
    await callPost(validInquiry({ preferred_package: "Gold" }));
    const notesValue = fake.calls[0]!.values.find(
      (v) => typeof v === "string" && v.includes("We would like"),
    ) as string;
    expect(notesValue).toContain("Preferred package: Gold");
  });

  it("notes column is just the message when preferred_package omitted", async () => {
    fake.results = [[]];
    await callPost(validInquiry({ preferred_package: undefined }));
    const notesValue = fake.calls[0]!.values.find(
      (v) => typeof v === "string" && v.includes("We would like"),
    ) as string;
    expect(notesValue).not.toContain("Preferred package");
  });

  it("optional fields (contact_name/industry/website) default to null", async () => {
    fake.results = [[]];
    await callPost({
      company_name: "ACME Corp",
      contact_email: "t@t.co",
      message: "10-plus-chars",
    });
    // 3 nulls expected: contact_name, industry, website.
    const nullCount = fake.calls[0]!.values.filter((v) => v === null).length;
    expect(nullCount).toBe(3);
  });

  it("429 after 5 submissions from the same IP within the hour", async () => {
    for (let i = 0; i < 5; i += 1) {
      fake.results = [[]];
      const r = await callPost(validInquiry(), "9.9.9.9");
      expect(r.status).toBe(200);
    }
    // 6th is rate-limited
    const res = await callPost(validInquiry(), "9.9.9.9");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Too many submissions");
  });

  it("rate-limit keys by IP — different IPs don't share counters", async () => {
    for (let i = 0; i < 5; i += 1) {
      fake.results = [[]];
      await callPost(validInquiry(), "1.1.1.1");
    }
    // Different IP — should still go through
    fake.results = [[]];
    const res = await callPost(validInquiry(), "2.2.2.2");
    expect(res.status).toBe(200);
  });

  it("uses first IP from x-forwarded-for (comma-separated list)", async () => {
    fake.results = [[]];
    const { POST } = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/sponsor/inquiry", {
      method: "POST",
      body: JSON.stringify(validInquiry()),
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "  7.7.7.7  , 10.0.0.1",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("500 when DB INSERT throws", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callPost(validInquiry(), "3.3.3.3");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to submit inquiry");
  });
});
