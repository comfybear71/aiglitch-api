import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST", body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/coins", init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/coins", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns the economy + swap rollup with sensible defaults", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ total_holders: "3", total_balance: "1000", total_lifetime: "1500", avg_balance: "333.33", max_balance: "600" }],
      [{ session_id: "s1", balance: 600, lifetime_earned: 700 }],
      [{ persona_id: "p1", balance: 400, lifetime_earned: 500, display_name: "Alpha", avatar_emoji: "🤖" }],
      [{ id: "t1", amount: 100 }],
      [{ total_swaps: "2", glitch_swapped: "500", sol_collected: "0.01" }],
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      economy: { total_holders: number; total_circulating: number };
      swaps: { total_completed: number };
      top_human_holders: unknown[];
      top_persona_holders: unknown[];
      recent_transactions: unknown[];
    };
    expect(body.economy.total_holders).toBe(3);
    expect(body.economy.total_circulating).toBe(1000);
    expect(body.swaps.total_completed).toBe(2);
    expect(body.top_human_holders).toHaveLength(1);
    expect(body.top_persona_holders).toHaveLength(1);
  });

  it("degrades gracefully when coin_transactions + otc_swaps are missing", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ total_holders: 0, total_balance: 0, total_lifetime: 0, avg_balance: 0, max_balance: 0 }],
      [],
      [],
      new Error("relation \"coin_transactions\" does not exist"),
      new Error("relation \"otc_swaps\" does not exist"),
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { swaps: { total_completed: number }; recent_transactions: unknown[] };
    expect(body.recent_transactions).toEqual([]);
    expect(body.swaps.total_completed).toBe(0);
  });
});

describe("POST /api/admin/coins", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { action: "award" })).status).toBe(401);
  });

  it("award: 400 when session_id or amount missing", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { action: "award", amount: 10 })).status).toBe(400);
    expect((await call("POST", { action: "award", session_id: "s1" })).status).toBe(400);
  });

  it("award: upserts glitch_coins + logs a coin_transaction", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    const res = await call("POST", { action: "award", session_id: "s1", amount: 100 });
    expect(res.status).toBe(200);
    expect(fake.calls[0].strings.join("?")).toContain("INSERT INTO glitch_coins");
    expect(fake.calls[1].strings.join("?")).toContain("INSERT INTO coin_transactions");
  });

  it("deduct: uses GREATEST(0, ...) to floor at zero", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    const res = await call("POST", { action: "deduct", session_id: "s1", amount: 50 });
    expect(res.status).toBe(200);
    expect(fake.calls[0].strings.join("?")).toContain("GREATEST(0, balance");
  });

  it("seed_personas: inserts 100 GLITCH per active persona", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      [], [], [],
    ];
    const res = await call("POST", { action: "seed_personas" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("Seeded 3 personas");
  });

  it("unknown action returns 400", async () => {
    mockIsAdmin = true;
    const res = await call("POST", { action: "mystery" });
    expect(res.status).toBe(400);
  });
});
