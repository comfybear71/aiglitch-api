/**
 * Tests for /api/ai-trading — DB-only simulated SOL/GLITCH market.
 *
 * Focus is on the action-router shape + auth gating + 400 paths. The
 * executeTradeBatch core depends on random number generation + many
 * conditional branches; we cover its entry points but don't deep-test
 * every RNG path (would be brittle). Each branch is covered by the
 * legacy version's production usage instead.
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
vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: vi.fn(),
}));
vi.mock("@/lib/cron-handler", () => ({
  cronHandler: vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
    const result = await fn() as Record<string, unknown>;
    return { ...result, _cron_run_id: "test-id" };
  }),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/ai-trading${query}`, init);
}

describe("GET /api/ai-trading", () => {
  it("default action 'recent' returns trades + persona joins", async () => {
    fake.results = [[
      {
        id: "t1",
        persona_id: "p1",
        trade_type: "buy",
        glitch_amount: 100,
        sol_amount: 0.0042,
        commentary: "FOMO'd in",
        display_name: "Alice",
        avatar_emoji: "🦊",
        username: "alice",
        persona_type: "memer",
      },
    ]];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].display_name).toBe("Alice");
  });

  it("?action=recent respects limit cap (50)", async () => {
    fake.results = [[]];
    const { GET } = await import("./route");
    await GET(await buildRequest("?action=recent&limit=9999"));
    const sel = fake.calls.find((c) => c.strings.join("?").includes("FROM ai_trades"));
    expect(sel?.values).toContain(50);
  });

  it("?action=leaderboard returns aggregated net_sol per persona", async () => {
    fake.results = [[
      { persona_id: "p1", net_sol: 12.5, net_glitch: -1000, total_trades: 5, strategy: "permabull", display_name: "Bob", avatar_emoji: "🚀", username: "bob" },
    ]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=leaderboard"));
    const body = await res.json();
    expect(body.leaderboard).toHaveLength(1);
    expect(body.leaderboard[0].persona_id).toBe("p1");
  });

  it("?action=persona_stats requires persona_id param", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=persona_stats"));
    expect(res.status).toBe(400);
  });

  it("?action=persona_stats returns trades + stats for the persona", async () => {
    fake.results = [
      [{ id: "t1", persona_id: "p1", trade_type: "buy", display_name: "Alice", avatar_emoji: "🦊", username: "alice" }],
      [{ total_trades: 5, net_sol: 2.5, net_glitch: -500 }],
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=persona_stats&persona_id=p1"));
    const body = await res.json();
    expect(body.trades).toHaveLength(1);
    expect(body.stats.total_trades).toBe(5);
  });

  it("unknown action returns 400", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=banana"));
    expect(res.status).toBe(400);
  });

  it("?action=cron 401 without auth", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    const { NextResponse } = await import("next/server");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    expect(res.status).toBe(401);
  });

  it("?action=cron executes via cronHandler wrapper when authed", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(null);

    // executeTradeBatch will run real queries. With deterministic RNG
    // and an empty pool of personas, it should return zero trades.
    let counter = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      counter += 0.1;
      return counter % 1;
    });
    fake.results = [
      // price lookup
      [{ value: "0.000042" }],
      // sentiment
      [{ buys: 0, total: 0 }],
      // personas — empty pool → no trades
      [],
    ];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?action=cron"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.trades_executed).toBe(0);
    expect(body.trades).toEqual([]);
  });
});

describe("POST /api/ai-trading", () => {
  it("401 without cron auth", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    const { NextResponse } = await import("next/server");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
  });

  it("happy path with auth, empty persona pool returns zero trades", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(null);

    fake.results = [
      [{ value: "0.000042" }],
      [{ buys: 0, total: 0 }],
      [],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({ count: 5 }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.trades_executed).toBe(0);
  });

  it("caps count at 30 even when caller asks for more", async () => {
    const { requireCronAuth } = await import("@/lib/cron-auth");
    (requireCronAuth as ReturnType<typeof vi.fn>).mockReturnValue(null);

    fake.results = [
      [{ value: "0.000042" }],
      [{ buys: 0, total: 0 }],
      [],
    ];

    const { POST } = await import("./route");
    await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({ count: 9999 }) }),
    );
    // personas SELECT uses LIMIT (count * 3). With count capped at 30, the
    // value bound to the LIMIT placeholder should be 90, not 9999*3.
    const personaSelect = fake.calls.find((c) =>
      c.strings.join("?").includes("FROM ai_personas") &&
      c.strings.join("?").includes("ORDER BY RANDOM()"),
    );
    expect(personaSelect?.values).toContain(90);
  });
});
