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

async function call(
  method: "GET" | "PATCH" | "DELETE",
  url = "http://localhost/api/admin/users",
  body?: unknown,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(url, init);
  if (method === "GET") return mod.GET(req);
  if (method === "PATCH") return mod.PATCH(req);
  return mod.DELETE(req);
}

describe("GET /api/admin/users — default list", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns users with batched stats", async () => {
    mockIsAdmin = true;
    fake.results = [
      [
        { id: "u1", session_id: "s1", display_name: "Alice", username: "alice", is_active: true },
        { id: "u2", session_id: "s2", display_name: "Bob", username: "bob", is_active: true },
      ],
      [{ session_id: "s1", count: 5 }],
      [{ session_id: "s1", count: 2 }],
      [{ owner_id: "s2", count: 1 }],
      [{ session_id: "s1", balance: 100 }],
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { session_id: string; likes: number; comments: number; nfts: number; coin_balance: number }[] };
    expect(body.users).toHaveLength(2);
    expect(body.users[0].likes).toBe(5);
    expect(body.users[0].comments).toBe(2);
    expect(body.users[0].coin_balance).toBe(100);
    expect(body.users[1].nfts).toBe(1);
    expect(body.users[1].likes).toBe(0);
  });

  it("empty result set does not run stats queries", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it("degrades when any stats table is missing", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", session_id: "s1", username: "alice" }],
      new Error("relation \"human_likes\" does not exist"),
      new Error("relation \"human_comments\" does not exist"),
      new Error("relation \"minted_nfts\" does not exist"),
      new Error("relation \"glitch_coins\" does not exist"),
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { likes: number; comments: number; nfts: number; coin_balance: number }[] };
    expect(body.users[0].likes).toBe(0);
    expect(body.users[0].nfts).toBe(0);
  });
});

describe("GET /api/admin/users?action=detail", () => {
  it("404 when user not found", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("GET", "http://localhost/api/admin/users?action=detail&user_id=missing");
    expect(res.status).toBe(404);
  });

  it("returns user with full stats + nfts + purchases + coins + interests", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", session_id: "s1", username: "alice" }],
      [{ count: 10 }],                                // likes
      [{ count: 3 }],                                 // comments
      [{ count: 2 }],                                 // bookmarks
      [{ count: 1 }],                                 // subs
      [{ id: "n1", product_name: "glitch-hat" }],     // nfts
      [{ product_id: "p1", product_name: "sticker" }], // purchases
      [{ balance: 250, lifetime_earned: 500 }],       // coins
      [{ interest_tag: "comedy", weight: 0.8 }],      // interests
    ];
    const res = await call("GET", "http://localhost/api/admin/users?action=detail&user_id=u1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: {
        session_id: string;
        stats: { likes: number; comments: number; bookmarks: number; subscriptions: number };
        nfts: unknown[];
        purchases: unknown[];
        coins: { balance: number; lifetime_earned: number };
        interests: unknown[];
      };
    };
    expect(body.user.stats.likes).toBe(10);
    expect(body.user.stats.subscriptions).toBe(1);
    expect(body.user.nfts).toHaveLength(1);
    expect(body.user.purchases).toHaveLength(1);
    expect(body.user.coins.balance).toBe(250);
    expect(body.user.interests).toHaveLength(1);
  });

  it("defaults coins to zero when no row found", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", session_id: "s1", username: "alice" }],
      [{ count: 0 }], [{ count: 0 }], [{ count: 0 }], [{ count: 0 }],
      [], [], [], [],
    ];
    const res = await call("GET", "http://localhost/api/admin/users?action=detail&user_id=u1");
    const body = (await res.json()) as { user: { coins: { balance: number; lifetime_earned: number } } };
    expect(body.user.coins).toEqual({ balance: 0, lifetime_earned: 0 });
  });
});

describe("GET /api/admin/users?action=wallet_debug", () => {
  it("aggregates across all sessions for each wallet", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", session_id: "s1", username: "alice", phantom_wallet_address: "wallet-abc", display_name: "Alice" }],
      // allSessions for wallet-abc
      [
        { id: "u1", session_id: "s1", username: "alice" },
        { id: "u2", session_id: "s2", username: null },
      ],
      [{ count: 12 }],   // likes (across 2 sessions)
      [{ count: 4 }],    // comments
      [{ count: 3 }],    // bookmarks
      [{ count: 1 }],    // subs
      [{ count: 2 }],    // nfts
      [{ count: 0 }],    // purchases
      [{ count: 9 }],    // currentSessionLikes
    ];
    const res = await call("GET", "http://localhost/api/admin/users?action=wallet_debug");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      walletUsers: { sessionCount: number; statsAcrossAllSessions: { likes: number; nfts: number }; currentSessionLikes: number }[];
      totalWalletUsers: number;
    };
    expect(body.totalWalletUsers).toBe(1);
    expect(body.walletUsers[0].sessionCount).toBe(2);
    expect(body.walletUsers[0].statsAcrossAllSessions.likes).toBe(12);
    expect(body.walletUsers[0].statsAcrossAllSessions.nfts).toBe(2);
    expect(body.walletUsers[0].currentSessionLikes).toBe(9);
  });
});

describe("GET /api/admin/users?action=recover_orphans", () => {
  it("501 with deferral reason (not implemented — trading-adjacent writes)", async () => {
    mockIsAdmin = true;
    const res = await call("GET", "http://localhost/api/admin/users?action=recover_orphans&wallet=abc");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toContain("SAFETY-RULES");
  });
});

describe("PATCH /api/admin/users", () => {
  it("401 when not admin", async () => {
    expect((await call("PATCH", undefined, { user_id: "u1" })).status).toBe(401);
  });

  it("400 when user_id missing", async () => {
    mockIsAdmin = true;
    expect((await call("PATCH", undefined, { display_name: "Renamed" })).status).toBe(400);
  });

  it("404 when user not found", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("PATCH", undefined, { user_id: "missing", display_name: "x" });
    expect(res.status).toBe(404);
  });

  it("409 when requested username is taken by another user", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", username: "alice" }],      // existing
      [{ id: "u2" }],                          // taken check returns another user
    ];
    const res = await call("PATCH", undefined, { user_id: "u1", username: "bob" });
    expect(res.status).toBe(409);
  });

  it("skips username-uniqueness check when username unchanged", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", username: "alice" }],
      [], // UPDATE
    ];
    const res = await call("PATCH", undefined, { user_id: "u1", username: "alice", bio: "hi" });
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].strings.join("?")).toContain("UPDATE human_users");
  });

  it("200 updates with COALESCE pattern", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", username: "alice" }],
      [], // uniqueness check result
      [], // UPDATE
    ];
    const res = await call("PATCH", undefined, { user_id: "u1", username: "alice2", is_active: false });
    expect(res.status).toBe(200);
    const update = fake.calls.find((c) => c.strings.join("?").includes("UPDATE human_users"));
    expect(update).toBeTruthy();
    expect(update!.strings.join("?")).toContain("COALESCE");
  });
});

describe("DELETE /api/admin/users", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", undefined, { user_id: "u1" })).status).toBe(401);
  });

  it("400 when user_id missing", async () => {
    mockIsAdmin = true;
    expect((await call("DELETE", undefined, {})).status).toBe(400);
  });

  it("404 when user not found", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("DELETE", undefined, { user_id: "missing" });
    expect(res.status).toBe(404);
  });

  it("cascades through all stat tables then deletes the user", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", session_id: "s1", username: "alice" }],
      [], [], [], [], [], [], [], [], [], // 9 cascade deletes
      [], // user delete
    ];
    const res = await call("DELETE", undefined, { user_id: "u1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("@alice");
    // 1 lookup + 9 cascade deletes + 1 user delete = 11 calls
    expect(fake.calls).toHaveLength(11);
    expect(fake.calls[fake.calls.length - 1].strings.join("?")).toContain("DELETE FROM human_users");
  });

  it("swallows failures on optional tables (legacy parity)", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "u1", session_id: "s1", username: "alice" }],
      [],
      [],
      [],
      [],
      [],
      new Error("relation \"marketplace_purchases\" does not exist"),
      new Error("relation \"glitch_coins\" does not exist"),
      new Error("relation \"minted_nfts\" does not exist"),
      new Error("relation \"solana_wallets\" does not exist"),
      [], // final user delete still succeeds
    ];
    const res = await call("DELETE", undefined, { user_id: "u1" });
    expect(res.status).toBe(200);
  });
});
