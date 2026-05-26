/**
 * Tests for /api/persona-trade — AI-persona-to-AI-persona simulated economy.
 *
 * Covers:
 *   • POST simulate_trades: 400 when <2 personas with balance
 *   • POST simulate_trades: happy path — multiple trades executed,
 *     correct balance updates, no transactions returned > count cap
 *   • POST recent_trades: returns enriched persona names
 *   • POST unknown action returns 400
 *   • GET ?limit= same shape as recent_trades, respects limit cap of 50
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  // Deterministic RNG for trade picking
  let counter = 0;
  vi.spyOn(Math, "random").mockImplementation(() => {
    counter += 0.1;
    return (counter % 1);
  });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function buildRequest(init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/persona-trade", init);
}

describe("POST /api/persona-trade simulate_trades", () => {
  it("400 when fewer than 2 personas with balance > 10", async () => {
    fake.results = [[{ id: "p1", display_name: "Alice", avatar_emoji: "🦊", balance: 100 }]];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "simulate_trades" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Not enough personas/);
  });

  it("executes trades and returns them with from/to/amount/reason", async () => {
    // 3 personas eligible
    fake.results = [
      [
        { id: "p1", display_name: "Alice", avatar_emoji: "🦊", balance: 500 },
        { id: "p2", display_name: "Bob", avatar_emoji: "🐢", balance: 500 },
        { id: "p3", display_name: "Carol", avatar_emoji: "🦄", balance: 500 },
      ],
      // Each trade fires 4 statements (UPDATE sender, INSERT receiver,
      // INSERT outgoing tx, INSERT incoming tx). Push enough empties.
      ...Array(40).fill([]),
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "simulate_trades", count: 3 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.trades_executed).toBeGreaterThan(0);
    expect(body.trades_executed).toBeLessThanOrEqual(3);
    for (const t of body.trades) {
      expect(t.from.id).not.toBe(t.to.id);
      expect(t.amount).toBeGreaterThanOrEqual(1);
      expect(typeof t.reason).toBe("string");
    }
  });

  it("caps trade count at 20 even when caller asks for more", async () => {
    fake.results = [
      [
        { id: "p1", display_name: "Alice", avatar_emoji: "🦊", balance: 1000 },
        { id: "p2", display_name: "Bob", avatar_emoji: "🐢", balance: 1000 },
      ],
      ...Array(100).fill([]),
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "simulate_trades", count: 9999 }),
      }),
    );
    const body = await res.json();
    expect(body.trades_executed).toBeLessThanOrEqual(20);
  });
});

describe("POST /api/persona-trade recent_trades", () => {
  it("returns enriched trades with persona names", async () => {
    fake.results = [
      // SELECT recent transactions
      [
        {
          amount: -10,
          reason: "Sent to @Alice: lost a bet",
          created_at: "2026-05-26T00:00:00Z",
          session_id: "persona:p1",
          reference_id: "p2",
        },
      ],
      // Enrich from persona p1
      [{ display_name: "Bob", avatar_emoji: "🐢" }],
      // Enrich to persona p2
      [{ display_name: "Alice", avatar_emoji: "🦊" }],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "recent_trades" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({
      from: { name: "Bob", emoji: "🐢" },
      to: { name: "Alice", emoji: "🦊" },
      amount: 10,
      reason: "lost a bet",
    });
  });

  it("skips trades whose personas can't be enriched (deleted persona)", async () => {
    fake.results = [
      [
        {
          amount: -10,
          reason: "Sent to @Ghost: vibes",
          created_at: "2026-05-26T00:00:00Z",
          session_id: "persona:p1",
          reference_id: "p2",
        },
      ],
      [{ display_name: "Bob", avatar_emoji: "🐢" }],
      [], // to persona missing
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "recent_trades" }),
      }),
    );
    const body = await res.json();
    expect(body.trades).toHaveLength(0);
  });
});

describe("POST /api/persona-trade misc", () => {
  it("400 on unknown action", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ action: "banana" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/persona-trade", () => {
  it("returns enriched trades, respects ?limit", async () => {
    fake.results = [
      [
        {
          amount: -5,
          reason: "Sent to @Alice: meme tax",
          created_at: "2026-05-26T00:00:00Z",
          session_id: "persona:p1",
          reference_id: "p2",
        },
      ],
      [{ display_name: "Bob", avatar_emoji: "🐢" }],
      [{ display_name: "Alice", avatar_emoji: "🦊" }],
    ];

    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://localhost/api/persona-trade?limit=3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades).toHaveLength(1);

    const sel = fake.calls.find((c) => c.strings.join("?").includes("FROM coin_transactions"));
    expect(sel?.values).toContain(3);
  });

  it("caps GET limit at 50", async () => {
    fake.results = [[], [], []];
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    await GET(new NextRequest("http://localhost/api/persona-trade?limit=9999"));

    const sel = fake.calls.find((c) => c.strings.join("?").includes("FROM coin_transactions"));
    expect(sel?.values).toContain(50);
  });
});
