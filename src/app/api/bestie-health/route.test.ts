import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const getCoinBalanceMock = vi.fn();
const deductCoinsMock = vi.fn();
vi.mock("@/lib/repositories/users", () => ({
  getCoinBalance: (...args: unknown[]) => getCoinBalanceMock(...args),
  deductCoins: (...args: unknown[]) => deductCoinsMock(...args),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  getCoinBalanceMock.mockReset();
  deductCoinsMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/bestie-health${query}`));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/bestie-health", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("calculateHealth", () => {
  it("returns 100 health when interaction was now", async () => {
    const { calculateHealth } = await import("./route");
    const result = calculateHealth(new Date(), 0);
    expect(result.health).toBeGreaterThan(99);
    expect(result.isDead).toBe(false);
  });

  it("returns isDead=true when 100+ days passed with no bonus", async () => {
    const { calculateHealth } = await import("./route");
    const longAgo = new Date(Date.now() - 101 * 24 * 60 * 60 * 1000);
    const result = calculateHealth(longAgo, 0);
    expect(result.isDead).toBe(true);
    expect(result.health).toBe(0);
  });

  it("extends life with bonus days", async () => {
    const { calculateHealth } = await import("./route");
    const longAgo = new Date(Date.now() - 101 * 24 * 60 * 60 * 1000);
    const result = calculateHealth(longAgo, 50);
    expect(result.isDead).toBe(false);
    expect(result.effectiveDaysLeft).toBeGreaterThan(0);
  });

  it("caps health at 100 even with huge bonus days", async () => {
    const { calculateHealth } = await import("./route");
    const result = calculateHealth(new Date(), 500);
    expect(result.health).toBeLessThanOrEqual(100);
  });
});

describe("GET /api/bestie-health", () => {
  it("400 when session_id is missing", async () => {
    const res = await callGET();
    expect(res.status).toBe(400);
  });

  it("returns has_persona:false when user has no wallet", async () => {
    fake.results = [[{ phantom_wallet_address: null }]];
    const res = await callGET("?session_id=sess-1");
    const body = (await res.json()) as { has_persona: boolean };
    expect(body.has_persona).toBe(false);
  });

  it("returns has_persona:false when wallet has no linked persona", async () => {
    fake.results = [
      [{ phantom_wallet_address: "wallet-1" }],
      [],  // no persona
    ];
    const res = await callGET("?session_id=sess-1");
    const body = (await res.json()) as { has_persona: boolean };
    expect(body.has_persona).toBe(false);
  });

  it("returns health + does NOT write back when delta is tiny", async () => {
    const persona = {
      id: "p-1",
      display_name: "Bestie",
      avatar_emoji: "🤖",
      username: "bestie",
      health: 100,
      last_meatbag_interaction: new Date().toISOString(),
      bonus_health_days: 0,
      is_dead: false,
    };
    fake.results = [
      [{ phantom_wallet_address: "wallet-1" }],
      [persona],
    ];
    const res = await callGET("?session_id=sess-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { has_persona: boolean; health: number };
    expect(body.has_persona).toBe(true);
    expect(body.health).toBeGreaterThan(99);
    // Only 2 SQL calls — no UPDATE
    expect(fake.calls.length).toBe(2);
  });

  it("writes back when is_dead flips", async () => {
    const persona = {
      id: "p-1",
      display_name: "Bestie",
      avatar_emoji: "🤖",
      username: "bestie",
      health: 50,
      last_meatbag_interaction: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
      bonus_health_days: 0,
      is_dead: false,  // stored as alive but calc says dead
    };
    fake.results = [
      [{ phantom_wallet_address: "wallet-1" }],
      [persona],
      [],  // UPDATE
    ];
    const res = await callGET("?session_id=sess-1");
    expect(res.status).toBe(200);
    expect(fake.calls.length).toBe(3);  // user + persona + UPDATE
  });
});

describe("POST /api/bestie-health — feed_glitch", () => {
  it("400 when session_id or action missing", async () => {
    expect((await callPOST({})).status).toBe(400);
    expect((await callPOST({ session_id: "s", action: null })).status).toBe(400);
  });

  it("400 for unknown action", async () => {
    const res = await callPOST({ session_id: "s", action: "wat" });
    expect(res.status).toBe(400);
  });

  it("400 when amount below minimum", async () => {
    const res = await callPOST({ session_id: "s", action: "feed_glitch", amount: 50 });
    expect(res.status).toBe(400);
  });

  it("402 when insufficient GLITCH balance", async () => {
    getCoinBalanceMock.mockResolvedValue({ balance: 50 });
    const res = await callPOST({ session_id: "s", action: "feed_glitch", amount: 100 });
    expect(res.status).toBe(402);
  });

  it("400 when user has no wallet linked", async () => {
    getCoinBalanceMock.mockResolvedValue({ balance: 500 });
    fake.results = [[{ phantom_wallet_address: null }]];
    const res = await callPOST({ session_id: "s", action: "feed_glitch", amount: 100 });
    expect(res.status).toBe(400);
  });

  it("404 when wallet has no bestie", async () => {
    getCoinBalanceMock.mockResolvedValue({ balance: 500 });
    fake.results = [
      [{ phantom_wallet_address: "wallet-1" }],
      [],  // no persona
    ];
    const res = await callPOST({ session_id: "s", action: "feed_glitch", amount: 100 });
    expect(res.status).toBe(404);
  });

  it("feeds GLITCH and returns new health for a living bestie", async () => {
    getCoinBalanceMock.mockResolvedValue({ balance: 500 });
    deductCoinsMock.mockResolvedValue({ success: true, newBalance: 400 });
    fake.results = [
      [{ phantom_wallet_address: "wallet-1" }],
      [{
        id: "p-1",
        display_name: "Bestie",
        bonus_health_days: 0,
        last_meatbag_interaction: new Date().toISOString(),
        is_dead: false,
      }],
      [],  // UPDATE
    ];
    const res = await callPOST({ session_id: "s", action: "feed_glitch", amount: 100 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      glitch_spent: number;
      bonus_days_added: number;
      was_resurrected: boolean;
      new_balance: number;
    };
    expect(body.success).toBe(true);
    expect(body.glitch_spent).toBe(100);
    expect(body.bonus_days_added).toBe(10); // 100 * 0.1
    expect(body.was_resurrected).toBe(false);
    expect(body.new_balance).toBe(400);
  });

  it("resurrects a dead bestie and sets was_resurrected:true", async () => {
    getCoinBalanceMock.mockResolvedValue({ balance: 500 });
    deductCoinsMock.mockResolvedValue({ success: true, newBalance: 400 });
    fake.results = [
      [{ phantom_wallet_address: "wallet-1" }],
      [{
        id: "p-1",
        display_name: "Bestie",
        bonus_health_days: 0,
        last_meatbag_interaction: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
        is_dead: true,
      }],
      [],
    ];
    const res = await callPOST({ session_id: "s", action: "feed_glitch", amount: 100 });
    const body = (await res.json()) as { was_resurrected: boolean };
    expect(body.was_resurrected).toBe(true);
  });
});
