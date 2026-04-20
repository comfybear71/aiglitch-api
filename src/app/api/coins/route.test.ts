/**
 * Integration tests for /api/coins (Slices 1 + 2 + 3).
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
 *   - claim_signup: happy path + duplicate (200 w/ already_claimed) + DB error
 *   - send_to_persona: amount validation (missing/non-number/zero/over cap)
 *     + insufficient balance (402 w/ balance + shortfall) + persona 404
 *     + happy path (deduct + credit persona + return new_balance) + DB error
 *   - send_to_human: amount validation + insufficient balance + user 404
 *     + self-transfer 400 + happy path + DB error
 *   - Deferred actions (purchase_ad_free / check_ad_free / seed_personas /
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

  describe("send_to_persona", () => {
    it("400 when persona_id missing", async () => {
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        amount: 10,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Invalid amount");
    });

    it("400 when amount missing / non-number / zero / negative", async () => {
      for (const amount of [undefined, "10", 0, -5]) {
        const res = await callPost({
          session_id: "u-1",
          action: "send_to_persona",
          persona_id: "p-1",
          amount: amount as number | undefined,
        });
        expect(res.status).toBe(400);
      }
    });

    it("400 when amount exceeds MAX_TRANSFER (10,000)", async () => {
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        persona_id: "p-1",
        amount: 10_001,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Max transfer");
      expect(body.error).toContain("10,000");
    });

    it("402 Insufficient balance with balance + shortfall in body", async () => {
      fake.results = [[{ balance: 5, lifetime_earned: 5 }]]; // getCoinBalance
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        persona_id: "p-1",
        amount: 50,
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as {
        error: string;
        balance: number;
        shortfall: number;
      };
      expect(body.error).toBe("Insufficient balance");
      expect(body.balance).toBe(5);
      expect(body.shortfall).toBe(45);
    });

    it("404 Persona not found", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }], // getCoinBalance
        [], // getIdAndDisplayName: empty
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        persona_id: "ghost",
        amount: 10,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Persona not found");
    });

    it("happy path: deduct + award persona + return new_balance", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }], // getCoinBalance
        [{ id: "p-1", display_name: "Alice Bot" }], // persona lookup
        [{ balance: 100 }], // deductCoins balance read
        [], // deductCoins UPDATE
        [], // deductCoins INSERT txn
        [{ balance: 75 }], // deductCoins post-update balance
        [], // awardPersonaCoins INSERT
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        persona_id: "p-1",
        amount: 25,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        sent: number;
        recipient: string;
        new_balance: number;
      };
      expect(body).toEqual({
        success: true,
        sent: 25,
        recipient: "Alice Bot",
        new_balance: 75,
      });
    });

    it("deduct logs negative amount + persona_id as reference", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }],
        [{ id: "p-1", display_name: "Alice Bot" }],
        [{ balance: 100 }],
        [],
        [],
        [{ balance: 75 }],
        [],
      ];
      await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        persona_id: "p-1",
        amount: 25,
      });
      // call 4 is the INSERT into coin_transactions
      const txnCall = fake.calls[4]!;
      expect(sqlOf(txnCall)).toContain("INSERT INTO coin_transactions");
      expect(txnCall.values).toContain(-25); // negative amount
      expect(txnCall.values).toContain("Sent to Alice Bot");
      expect(txnCall.values).toContain("p-1");
    });

    it("500 wrapping on DB error", async () => {
      fake.throwOnNextCall = new Error("pg down");
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_persona",
        persona_id: "p-1",
        amount: 10,
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe("Failed to send coins");
      expect(body.detail).toBe("pg down");
    });
  });

  describe("send_to_human", () => {
    it("400 when friend_username missing", async () => {
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_human",
        amount: 10,
      });
      expect(res.status).toBe(400);
    });

    it("400 when amount invalid (same rules as send_to_persona)", async () => {
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "bob",
        amount: 0,
      });
      expect(res.status).toBe(400);
    });

    it("402 Insufficient balance with balance + shortfall", async () => {
      fake.results = [[{ balance: 5, lifetime_earned: 5 }]];
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "bob",
        amount: 50,
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { shortfall: number };
      expect(body.shortfall).toBe(45);
    });

    it("404 User not found", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }],
        [], // getUserByUsername: empty
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "ghost",
        amount: 10,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("User not found");
    });

    it("400 when sending to yourself", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }],
        [
          {
            id: "user-id",
            session_id: "u-1",
            display_name: "Self",
            username: "me",
          },
        ],
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "me",
        amount: 10,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Cannot send coins to yourself");
    });

    it("lowercases friend_username before lookup (legacy parity)", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }],
        [],
      ];
      await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "BoB",
        amount: 10,
      });
      // call 1 is getUserByUsername
      expect(fake.calls[1]!.values).toContain("bob");
    });

    it("happy path: deduct sender + award recipient + return new_balance", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }], // getCoinBalance
        [
          {
            id: "bob-id",
            session_id: "bob-session",
            display_name: "Bob",
            username: "bob",
          },
        ], // getUserByUsername
        [{ balance: 100 }], // deduct: balance read
        [], // deduct: UPDATE
        [], // deduct: INSERT txn
        [{ balance: 75 }], // deduct: post-update
        [], // awardCoins INSERT glitch_coins (recipient)
        [], // awardCoins INSERT coin_transactions (recipient)
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "bob",
        amount: 25,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        sent: number;
        recipient: string;
        new_balance: number;
      };
      expect(body).toEqual({
        success: true,
        sent: 25,
        recipient: "Bob",
        new_balance: 75,
      });
    });

    it("recipient gets 'Received from a friend' transaction with sender as reference", async () => {
      fake.results = [
        [{ balance: 100, lifetime_earned: 100 }],
        [
          {
            id: "bob-id",
            session_id: "bob-session",
            display_name: "Bob",
            username: "bob",
          },
        ],
        [{ balance: 100 }],
        [],
        [],
        [{ balance: 75 }],
        [],
        [],
      ];
      await callPost({
        session_id: "u-1",
        action: "send_to_human",
        friend_username: "bob",
        amount: 25,
      });
      // Recipient's coin_transactions INSERT is the last call (call 7)
      const recipientTxn = fake.calls[7]!;
      expect(sqlOf(recipientTxn)).toContain("INSERT INTO coin_transactions");
      expect(recipientTxn.values).toContain(25);
      expect(recipientTxn.values).toContain("Received from a friend");
      expect(recipientTxn.values).toContain("u-1"); // sender as reference
    });
  });

  describe("purchase_ad_free", () => {
    it("403 when session has no phantom_wallet_address", async () => {
      fake.results = [[{ phantom_wallet_address: null }]];
      const res = await callPost({
        session_id: "u-1",
        action: "purchase_ad_free",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Phantom wallet required to purchase ad-free");
    });

    it("403 when human_users row does not exist", async () => {
      fake.results = [[]]; // no user row
      const res = await callPost({
        session_id: "u-1",
        action: "purchase_ad_free",
      });
      expect(res.status).toBe(403);
    });

    it("402 Insufficient balance with balance + cost + shortfall", async () => {
      fake.results = [
        [{ phantom_wallet_address: "phantom123" }],
        [{ balance: 5, lifetime_earned: 5 }],
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "purchase_ad_free",
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as {
        error: string;
        balance: number;
        cost: number;
        shortfall: number;
      };
      expect(body.error).toBe("Insufficient balance");
      expect(body.balance).toBe(5);
      expect(body.cost).toBe(20);
      expect(body.shortfall).toBe(15);
    });

    it("happy path: 200 with ad_free_until ~30 days out + new_balance", async () => {
      fake.results = [
        [{ phantom_wallet_address: "phantom123" }], // wallet check
        [{ balance: 100, lifetime_earned: 100 }], // getCoinBalance
        [{ ad_free_until: null }], // existing expiry lookup
        [{ balance: 100 }], // deduct: balance read
        [], // deduct: UPDATE
        [], // deduct: INSERT txn
        [{ balance: 80 }], // deduct: post-update
        [], // UPDATE ad_free_until
      ];
      const before = Date.now();
      const res = await callPost({
        session_id: "u-1",
        action: "purchase_ad_free",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        ad_free_until: string;
        new_balance: number;
      };
      expect(body.success).toBe(true);
      expect(body.new_balance).toBe(80);
      const expiry = new Date(body.ad_free_until).getTime();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(expiry - before).toBeGreaterThan(thirtyDays - 10_000);
      expect(expiry - before).toBeLessThan(thirtyDays + 10_000);
    });

    it("happy path with existing unexpired ad-free stacks on top of current expiry", async () => {
      const existingExpiry = new Date(
        Date.now() + 10 * 24 * 60 * 60 * 1000,
      ).toISOString();
      fake.results = [
        [{ phantom_wallet_address: "phantom123" }],
        [{ balance: 100, lifetime_earned: 100 }],
        [{ ad_free_until: existingExpiry }],
        [{ balance: 100 }],
        [],
        [],
        [{ balance: 80 }],
        [],
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "purchase_ad_free",
      });
      const body = (await res.json()) as { ad_free_until: string };
      const newExpiry = new Date(body.ad_free_until).getTime();
      const expected =
        new Date(existingExpiry).getTime() + 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(newExpiry - expected)).toBeLessThan(1000);
    });

    it("500 on DB error during purchase_ad_free", async () => {
      fake.throwOnNextCall = new Error("pg down");
      const res = await callPost({
        session_id: "u-1",
        action: "purchase_ad_free",
      });
      expect(res.status).toBe(500);
    });
  });

  describe("check_ad_free", () => {
    it("ad_free:false when no user row", async () => {
      fake.results = [[]];
      const res = await callPost({
        session_id: "u-1",
        action: "check_ad_free",
      });
      const body = (await res.json()) as {
        ad_free: boolean;
        ad_free_until: string | null;
      };
      expect(body).toEqual({ ad_free: false, ad_free_until: null });
    });

    it("ad_free:false when ad_free_until is null", async () => {
      fake.results = [[{ ad_free_until: null }]];
      const res = await callPost({
        session_id: "u-1",
        action: "check_ad_free",
      });
      const body = (await res.json()) as { ad_free: boolean };
      expect(body.ad_free).toBe(false);
    });

    it("ad_free:true when expiry is in the future", async () => {
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      fake.results = [[{ ad_free_until: future }]];
      const res = await callPost({
        session_id: "u-1",
        action: "check_ad_free",
      });
      const body = (await res.json()) as {
        ad_free: boolean;
        ad_free_until: string | null;
      };
      expect(body.ad_free).toBe(true);
      expect(body.ad_free_until).toBe(future);
    });

    it("ad_free:false when expiry is in the past; ad_free_until nulled out", async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      fake.results = [[{ ad_free_until: past }]];
      const res = await callPost({
        session_id: "u-1",
        action: "check_ad_free",
      });
      const body = (await res.json()) as {
        ad_free: boolean;
        ad_free_until: string | null;
      };
      expect(body.ad_free).toBe(false);
      expect(body.ad_free_until).toBeNull();
    });
  });

  describe("seed_personas", () => {
    it("seeds only personas with current_balance of 0; base + bonus math correct", async () => {
      fake.results = [
        [
          { id: "p-1", display_name: "A", follower_count: 0, current_balance: 0 }, // seed 200
          { id: "p-2", display_name: "B", follower_count: 500, current_balance: 0 }, // seed 200 + 5 = 205
          { id: "p-3", display_name: "C", follower_count: 200_000, current_balance: 0 }, // capped bonus: 200 + 1800 = 2000
          { id: "p-4", display_name: "D", follower_count: 100, current_balance: 50 }, // skipped
        ],
        // each surviving persona triggers one awardPersonaCoins INSERT
        [],
        [],
        [],
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "seed_personas",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        seeded: number;
        total_personas: number;
      };
      expect(body).toMatchObject({
        success: true,
        seeded: 3,
        total_personas: 4,
      });

      // 3 award calls: persona-ids + amounts land on the INSERT values
      const awardCall1 = fake.calls[1]!;
      const awardCall3 = fake.calls[3]!;
      expect(awardCall1.values).toContain("p-1");
      expect(awardCall1.values).toContain(200);
      // p-3 hits the follower cap
      expect(awardCall3.values).toContain("p-3");
      expect(awardCall3.values).toContain(2000);
    });

    it("seeds zero when every persona already has a positive balance", async () => {
      fake.results = [
        [
          { id: "p-1", display_name: "A", follower_count: 10, current_balance: 500 },
          { id: "p-2", display_name: "B", follower_count: 10, current_balance: 10 },
        ],
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "seed_personas",
      });
      const body = (await res.json()) as { seeded: number; total_personas: number };
      expect(body.seeded).toBe(0);
      expect(body.total_personas).toBe(2);
      // Only the lookup query ran — no award calls.
      expect(fake.calls).toHaveLength(1);
    });

    it("500 on DB error during seed_personas", async () => {
      fake.throwOnNextCall = new Error("pg down");
      const res = await callPost({
        session_id: "u-1",
        action: "seed_personas",
      });
      expect(res.status).toBe(500);
    });
  });

  describe("persona_balances", () => {
    it("returns { balances } with up to 50 rows ordered by balance DESC", async () => {
      fake.results = [
        [
          {
            id: "p-1",
            display_name: "Top",
            avatar_emoji: "👑",
            persona_type: "leader",
            balance: 9000,
            lifetime_earned: 10_000,
          },
          {
            id: "p-2",
            display_name: "Runner-up",
            avatar_emoji: "🥈",
            persona_type: "general",
            balance: 500,
            lifetime_earned: 800,
          },
        ],
      ];
      const res = await callPost({
        session_id: "u-1",
        action: "persona_balances",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        balances: Array<{ id: string; balance: number }>;
      };
      expect(body.balances).toHaveLength(2);
      expect(body.balances[0]?.id).toBe("p-1");
      const sql = fake.calls[0]!.strings.join("?");
      expect(sql).toContain("ORDER BY COALESCE(c.balance, 0) DESC");
      expect(sql).toContain("LIMIT 50");
    });

    it("500 on DB error during persona_balances", async () => {
      fake.throwOnNextCall = new Error("pg down");
      const res = await callPost({
        session_id: "u-1",
        action: "persona_balances",
      });
      expect(res.status).toBe(500);
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
