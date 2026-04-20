/**
 * Integration tests for /api/coins (Slices 1 + 2).
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
 *   - 400 on missing session_id or action
 *   - claim_signup: awards +100 GLITCH on first claim; returns
 *     {success:true, amount:100, reason:"Welcome bonus"}
 *   - claim_signup: duplicate returns 200 (not 4xx) with
 *     {error:"Already claimed", already_claimed:true} — legacy parity
 *   - claim_signup: 500 wrapping on DB error
 *   - Deferred actions (send_to_persona / send_to_human /
 *     purchase_ad_free / check_ad_free / seed_personas /
 *     persona_balances) return 501 `action_not_yet_migrated`
 *   - Unknown action returns 400
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
  it("400 when session_id missing", async () => {
    const res = await callPost({ action: "claim_signup" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing fields");
  });

  it("400 when action missing", async () => {
    const res = await callPost({ session_id: "u-1" });
    expect(res.status).toBe(400);
  });

  it("400 with no body at all (missing both)", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/coins", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  describe("claim_signup", () => {
    it("awards +100 GLITCH on first claim", async () => {
      fake.results = [
        [], // existing welcome-bonus lookup: none
        [], // INSERT glitch_coins (awardCoins)
        [], // INSERT coin_transactions (awardCoins)
      ];
      const res = await callPost({ action: "claim_signup", session_id: "u-1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        amount: number;
        reason: string;
      };
      expect(body).toEqual({
        success: true,
        amount: 100,
        reason: "Welcome bonus",
      });
    });

    it("INSERT glitch_coins + coin_transactions fire on first claim", async () => {
      fake.results = [[], [], []];
      await callPost({ action: "claim_signup", session_id: "u-1" });
      // 3 calls: lookup, upsert balance, insert transaction
      expect(fake.calls).toHaveLength(3);
      const upsertSql = sqlOf(fake.calls[1]!);
      expect(upsertSql).toContain("INSERT INTO glitch_coins");
      expect(upsertSql).toContain("ON CONFLICT (session_id)");
      const txnSql = sqlOf(fake.calls[2]!);
      expect(txnSql).toContain("INSERT INTO coin_transactions");
      expect(fake.calls[2]!.values).toContain(100);
      expect(fake.calls[2]!.values).toContain("Welcome bonus");
    });

    it("duplicate claim returns 200 with already_claimed (legacy parity — NOT 4xx)", async () => {
      fake.results = [[{ id: "existing-txn" }]]; // existing welcome bonus found
      const res = await callPost({ action: "claim_signup", session_id: "u-1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        error: string;
        already_claimed: boolean;
      };
      expect(body).toEqual({
        error: "Already claimed",
        already_claimed: true,
      });
      // Only the existence check fires — no award attempted
      expect(fake.calls).toHaveLength(1);
    });

    it("500 with detail on DB error during claim_signup", async () => {
      fake.throwOnNextCall = new Error("pg down");
      const res = await callPost({ action: "claim_signup", session_id: "u-1" });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe("Failed to claim signup bonus");
      expect(body.detail).toBe("pg down");
    });
  });

  describe("deferred actions", () => {
    const deferred = [
      "send_to_persona",
      "send_to_human",
      "purchase_ad_free",
      "check_ad_free",
      "seed_personas",
      "persona_balances",
    ];

    for (const action of deferred) {
      it(`${action} returns 501 action_not_yet_migrated`, async () => {
        const res = await callPost({ action, session_id: "u-1" });
        expect(res.status).toBe(501);
        const body = (await res.json()) as { error: string; action: string };
        expect(body.error).toBe("action_not_yet_migrated");
        expect(body.action).toBe(action);
      });
    }

    it("deferred actions never touch the DB", async () => {
      await callPost({ action: "send_to_persona", session_id: "u-1" });
      expect(fake.calls).toHaveLength(0);
    });
  });

  it("unknown action returns 400 Invalid action", async () => {
    const res = await callPost({
      action: "mystery_pizza",
      session_id: "u-1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; action: string };
    expect(body.error).toBe("Invalid action");
    expect(body.action).toBe("mystery_pizza");
  });
});
