/**
 * Integration tests for /api/coins — Slice 1 (GET only).
 *
 * GET covers:
 *   - Missing session_id returns zeros (legacy parity, no 400)
 *   - Zero balance + empty transactions when no rows exist
 *   - Real balance + lifetime_earned + transactions when rows exist
 *   - balance / lifetime_earned coerce to Number (Neon returns strings
 *     for numeric columns)
 *   - SQL orders transactions by created_at DESC, LIMIT 20
 *   - Cache-Control: private, no-store (session-personalised)
 *   - 500 wrapping on DB error
 *
 * POST covers:
 *   - Returns 501 `action_not_yet_migrated` with echoed action
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
  const req = new NextRequest(`http://localhost/api/coins${query}`);
  return GET(req);
}

async function callPost(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/coins", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(req);
}

function sqlOf(c: SqlCall): string {
  return c.strings.join("?");
}

describe("GET /api/coins", () => {
  it("returns zeros + empty transactions when session_id missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      balance: number;
      lifetime_earned: number;
      transactions: unknown[];
    };
    expect(body).toEqual({ balance: 0, lifetime_earned: 0, transactions: [] });
    expect(fake.calls).toHaveLength(0); // no DB touch when no session
  });

  it("returns zeros when session has no glitch_coins row yet", async () => {
    fake.results = [[], []]; // balance empty, transactions empty
    const res = await callGet("?session_id=new-user");
    const body = (await res.json()) as {
      balance: number;
      lifetime_earned: number;
      transactions: unknown[];
    };
    expect(body).toEqual({ balance: 0, lifetime_earned: 0, transactions: [] });
  });

  it("returns real balance + lifetime_earned + transactions", async () => {
    fake.results = [
      [{ balance: 57, lifetime_earned: 120 }],
      [
        { amount: 15, reason: "First comment", created_at: "2026-04-20T01:00:00Z" },
        { amount: 2, reason: "First like", created_at: "2026-04-20T00:30:00Z" },
      ],
    ];
    const res = await callGet("?session_id=u-1");
    const body = (await res.json()) as {
      balance: number;
      lifetime_earned: number;
      transactions: Array<{ amount: number; reason: string }>;
    };
    expect(body.balance).toBe(57);
    expect(body.lifetime_earned).toBe(120);
    expect(body.transactions).toHaveLength(2);
    expect(body.transactions[0]?.reason).toBe("First comment");
  });

  it("coerces string numeric columns to Number (Neon quirk)", async () => {
    // Neon returns `numeric` columns as JS strings; repo must coerce.
    fake.results = [
      [{ balance: "57", lifetime_earned: "120" }],
      [],
    ];
    const res = await callGet("?session_id=u-1");
    const body = (await res.json()) as {
      balance: unknown;
      lifetime_earned: unknown;
    };
    expect(typeof body.balance).toBe("number");
    expect(typeof body.lifetime_earned).toBe("number");
    expect(body.balance).toBe(57);
    expect(body.lifetime_earned).toBe(120);
  });

  it("transactions query orders by created_at DESC with LIMIT 20", async () => {
    fake.results = [[], []];
    await callGet("?session_id=u-1");
    const txnSql = sqlOf(fake.calls[1]!);
    expect(txnSql).toContain("ORDER BY created_at DESC");
    expect(fake.calls[1]!.values).toContain(20);
  });

  it("Cache-Control is private, no-store even on the empty branch", async () => {
    const resEmpty = await callGet();
    expect(resEmpty.headers.get("Cache-Control")).toBe("private, no-store");

    fake.results = [[], []];
    const resReal = await callGet("?session_id=u-1");
    expect(resReal.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("500 with detail on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("?session_id=u-1");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load coins");
    expect(body.detail).toBe("pg down");
  });
});

describe("POST /api/coins", () => {
  it("returns 501 action_not_yet_migrated and echoes the action", async () => {
    const res = await callPost({ action: "claim_signup", session_id: "u-1" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as {
      error: string;
      action: string | null;
    };
    expect(body.error).toBe("action_not_yet_migrated");
    expect(body.action).toBe("claim_signup");
  });

  it("returns 501 even with no body (action echoed as null)", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/coins", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { action: string | null };
    expect(body.action).toBeNull();
  });
});
