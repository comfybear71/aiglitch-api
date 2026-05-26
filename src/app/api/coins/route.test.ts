/**
 * /api/coins smoke tests — pins the legacy-parity response shape after
 * the v1.40.2 hotfix. The previous version returned 404 + a different
 * shape on missing users, crashing the consumer /me page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/coins${query}`, init);
}

describe("GET /api/coins", () => {
  it("returns zero-state for missing session_id (no 401/404)", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ balance: 0, lifetime_earned: 0, transactions: [] });
  });

  it("returns zero-state for sessions with no coin row (not 404)", async () => {
    // getCoinBalance lookup → empty rows, getTransactions → empty rows
    fake.results = [[], []];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?session_id=brand-new-user"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe(0);
    expect(body.lifetime_earned).toBe(0);
    expect(body.transactions).toEqual([]);
  });

  it("returns real balance + transactions when session has coins", async () => {
    fake.results = [
      [{ balance: 250, lifetime_earned: 500 }],
      [{ amount: 100, reason: "Welcome bonus", created_at: "2026-05-01" }],
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?session_id=existing"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe(250);
    expect(body.lifetime_earned).toBe(500);
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].reason).toBe("Welcome bonus");
  });
});

describe("POST /api/coins", () => {
  it("400 when missing session_id or action", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on unknown action", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "banana" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("claim_signup awards 100 GLITCH on first call", async () => {
    // claimSignupBonus: SELECT existing (empty) → awardCoins (INSERT glitch_coins) + (INSERT coin_transactions)
    fake.results = [[], [], []];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim_signup" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.amount).toBe(100);
  });

  it("claim_signup returns already_claimed on second call", async () => {
    fake.results = [[{ id: "existing-tx" }]];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "claim_signup" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_claimed).toBe(true);
  });

  it("send_to_persona rejects amounts above MAX_TRANSFER (10000)", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "send_to_persona",
          persona_id: "p1",
          amount: 99999,
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Max transfer/);
  });

  it("send_to_human 400 cannot send to yourself", async () => {
    // 1: getCoinBalance lookup (balance enough)
    // 2: getUserByUsername lookup (returns self)
    fake.results = [
      [{ balance: 500, lifetime_earned: 500 }],
      [{ id: "u1", session_id: "s1", display_name: "Self", username: "self" }],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "send_to_human",
          friend_username: "self",
          amount: 10,
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/yourself/);
  });
});
