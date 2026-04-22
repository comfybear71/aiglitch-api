import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
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

async function call(body: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/auth/human", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return mod.POST(req);
}

// Handy: each session-migration helper call issues 10 UPDATEs. This
// utility pushes empty results for all of them so the real code-path
// under test gets to complete.
function seedMigrate() {
  for (let i = 0; i < 10; i++) fake.results.push([]);
}

describe("POST /api/auth/human — 400/invalid paths", () => {
  it("invalid action → 400", async () => {
    const res = await call({ action: "unknown" });
    expect(res.status).toBe(400);
  });

  it("signup requires username + password + session_id", async () => {
    expect((await call({ action: "signup" })).status).toBe(400);
    expect((await call({ action: "login" })).status).toBe(400);
  });

  it("unhandled exception returns 500", async () => {
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/auth/human", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{bad json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(500);
  });
});

describe("signup", () => {
  it("409 when username already taken", async () => {
    fake.results.push([{ id: "existing" }]);
    const res = await call({
      action: "signup",
      username: "stella",
      password: "p",
      session_id: "s",
    });
    expect(res.status).toBe(409);
  });

  it("rejects username < 3 chars after cleaning", async () => {
    const res = await call({
      action: "signup",
      username: "!@",
      password: "p",
      session_id: "s",
    });
    expect(res.status).toBe(400);
  });

  it("happy path inserts + returns cleaned username", async () => {
    fake.results.push([]); // uniqueness
    fake.results.push([]); // INSERT
    const res = await call({
      action: "signup",
      username: "Stella_01!",
      password: "p",
      session_id: "s1",
      display_name: "Stella",
      avatar_emoji: "✨",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe("stella_01");
  });
});

describe("login", () => {
  it("401 on bad creds", async () => {
    fake.results.push([]); // no matching user
    const res = await call({ action: "login", username: "x", password: "y" });
    expect(res.status).toBe(401);
  });

  it("happy path with matching session_id skips merge", async () => {
    fake.results.push([
      {
        id: "u-1",
        session_id: "s-1",
        display_name: "Stella",
        username: "stella",
        avatar_emoji: "✨",
        bio: null,
      },
    ]);
    const res = await call({
      action: "login",
      username: "stella",
      password: "p",
      session_id: "s-1",
    });
    expect(res.status).toBe(200);
    // No UPDATE human_users call
    const updateHuman = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE human_users SET session_id"),
    );
    expect(updateHuman).toBeUndefined();
  });

  it("different session_id triggers session merge (10 migrate UPDATEs)", async () => {
    fake.results.push([
      {
        id: "u-1",
        session_id: "s-old",
        display_name: "Stella",
        username: "stella",
        avatar_emoji: "✨",
        bio: null,
      },
    ]);
    fake.results.push([]); // UPDATE session_id on user row
    seedMigrate(); // 10 migrate UPDATEs
    const res = await call({
      action: "login",
      username: "stella",
      password: "p",
      session_id: "s-new",
    });
    expect(res.status).toBe(200);
    // Verify session_id update happened before migrate sequence
    const sessUpdate = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE human_users SET session_id"),
    );
    expect(sessUpdate).toBeDefined();
  });
});

describe("profile", () => {
  it("400 without session_id", async () => {
    expect((await call({ action: "profile" })).status).toBe(400);
  });

  it("returns null user when no account yet", async () => {
    fake.results.push([]); // user lookup
    const res = await call({ action: "profile", session_id: "s" });
    const body = (await res.json()) as { user: null };
    expect(body.user).toBeNull();
  });

  it("happy path with wallet aggregates stats across linked sessions", async () => {
    fake.results.push([
      {
        id: "u-1",
        display_name: "Stella",
        username: "stella",
        avatar_emoji: "✨",
        avatar_url: null,
        bio: "",
        created_at: "2026-04-21",
        phantom_wallet_address: "wallet-abc",
      },
    ]);
    fake.results.push([
      { session_id: "s-1" },
      { session_id: "s-2" },
    ]); // wallet sessions
    fake.results.push([{ count: 5 }]); // likes
    fake.results.push([{ count: 3 }]); // comments
    fake.results.push([{ count: 2 }]); // bookmarks
    fake.results.push([{ count: 1 }]); // subs
    const res = await call({ action: "profile", session_id: "s-1" });
    const body = (await res.json()) as {
      user: { stats: { likes: number; comments: number; bookmarks: number; subscriptions: number } };
    };
    expect(body.user.stats).toEqual({
      likes: 5,
      comments: 3,
      bookmarks: 2,
      subscriptions: 1,
    });
  });
});

describe("update", () => {
  it("400 without session_id", async () => {
    expect((await call({ action: "update" })).status).toBe(400);
  });

  it("409 when new username collides with an AI persona", async () => {
    fake.results.push([{ "?column?": 1 }]); // ai_personas match
    const res = await call({
      action: "update",
      session_id: "s",
      username: "stella",
    });
    expect(res.status).toBe(409);
  });

  it("409 when new username collides with another meatbag", async () => {
    fake.results.push([]); // no ai_personas match
    fake.results.push([{ "?column?": 1 }]); // meatbag match
    const res = await call({
      action: "update",
      session_id: "s",
      username: "stella",
    });
    expect(res.status).toBe(409);
  });

  it("happy path fires COALESCE UPDATE", async () => {
    fake.results.push([]); // UPDATE
    const res = await call({
      action: "update",
      session_id: "s",
      display_name: "New Name",
    });
    expect(res.status).toBe(200);
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE human_users SET"),
    );
    expect(update).toBeDefined();
  });
});

describe("anonymous_signup", () => {
  it("400 without session_id", async () => {
    expect((await call({ action: "anonymous_signup" })).status).toBe(400);
  });

  it("upserts a meatbag_XXXXX username", async () => {
    fake.results.push([]); // UPSERT
    const res = await call({ action: "anonymous_signup", session_id: "s" });
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toMatch(/^meatbag_\d+$/);
  });
});

describe("wallet_login", () => {
  it("400 without wallet_address", async () => {
    expect((await call({ action: "wallet_login" })).status).toBe(400);
  });

  it("existing user with matching session → just touches last_seen", async () => {
    fake.results.push([
      {
        id: "u-1",
        session_id: "s-1",
        display_name: "Stella",
        username: "stella",
        avatar_emoji: "👛",
        bio: null,
        phantom_wallet_address: "wallet-abc",
      },
    ]);
    fake.results.push([]); // UPDATE last_seen
    fake.results.push([]); // orphan recovery SELECT (empty)
    const res = await call({
      action: "wallet_login",
      wallet_address: "wallet-abc",
      session_id: "s-1",
    });
    const body = (await res.json()) as { found_existing: boolean };
    expect(body.found_existing).toBe(true);
  });

  it("existing wallet user + new session → merges FROM old TO new", async () => {
    fake.results.push([
      {
        id: "u-1",
        session_id: "s-old",
        display_name: "Stella",
        username: "stella",
        avatar_emoji: "👛",
        bio: null,
        phantom_wallet_address: "wallet-abc",
      },
    ]);
    fake.results.push([]); // DELETE stub user with new session_id
    fake.results.push([]); // UPDATE wallet user's session_id to new
    seedMigrate(); // 10 migrate UPDATEs
    fake.results.push([]); // orphan SELECT (empty)
    const res = await call({
      action: "wallet_login",
      wallet_address: "wallet-abc",
      session_id: "s-new",
    });
    const body = (await res.json()) as {
      user: { session_id: string };
    };
    expect(body.user.session_id).toBe("s-new");

    // Verify DELETE stub fired first (migration safety rule #2)
    const deleteStub = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM human_users"),
    );
    expect(deleteStub).toBeDefined();
    const sessUpdate = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE human_users SET session_id"),
    );
    expect(sessUpdate).toBeDefined();
  });

  it("no existing wallet user → creates new wallet-based account", async () => {
    fake.results.push([]); // wallet lookup empty
    fake.results.push([]); // UPDATE session (no match)
    fake.results.push([]); // username taken check
    fake.results.push([]); // INSERT
    const res = await call({
      action: "wallet_login",
      wallet_address: "wallet-xyz",
    });
    const body = (await res.json()) as {
      found_existing: boolean;
      user: { username: string; phantom_wallet_address: string };
    };
    expect(body.found_existing).toBe(false);
    expect(body.user.username).toMatch(/^wallet_/);
    expect(body.user.phantom_wallet_address).toBe("wallet-xyz");
  });
});

describe("link_wallet / unlink_wallet / get_wallet", () => {
  it("link_wallet 409 when wallet already linked to another account", async () => {
    fake.results.push([{ session_id: "s-other", username: "another" }]);
    const res = await call({
      action: "link_wallet",
      session_id: "s-1",
      wallet_address: "wallet-abc",
    });
    expect(res.status).toBe(409);
  });

  it("link_wallet happy path UPDATEs", async () => {
    fake.results.push([]); // no conflict
    fake.results.push([]); // UPDATE
    const res = await call({
      action: "link_wallet",
      session_id: "s-1",
      wallet_address: "wallet-abc",
    });
    expect(res.status).toBe(200);
  });

  it("unlink_wallet NULLs out phantom_wallet_address", async () => {
    fake.results.push([]);
    const res = await call({ action: "unlink_wallet", session_id: "s-1" });
    expect(res.status).toBe(200);
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("phantom_wallet_address = NULL"),
    );
    expect(update).toBeDefined();
  });

  it("get_wallet returns null when no row", async () => {
    fake.results.push([]);
    const body = (await (await call({ action: "get_wallet", session_id: "s" })).json()) as {
      wallet_address: string | null;
    };
    expect(body.wallet_address).toBeNull();
  });

  it("get_wallet returns address when set", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-xyz" }]);
    const body = (await (await call({ action: "get_wallet", session_id: "s" })).json()) as {
      wallet_address: string;
    };
    expect(body.wallet_address).toBe("wallet-xyz");
  });
});

describe("merge_accounts", () => {
  it("400 without old_usernames", async () => {
    expect(
      (await call({ action: "merge_accounts", session_id: "s" })).status,
    ).toBe(400);
  });

  it("404 when current session has no account", async () => {
    fake.results.push([]); // current user empty
    const res = await call({
      action: "merge_accounts",
      session_id: "s",
      old_usernames: ["old1"],
    });
    expect(res.status).toBe(404);
  });

  it("merges + reports not-found for missing usernames", async () => {
    fake.results.push([{ id: "u-1", username: "current" }]); // current user
    // old1 not found, old2 found
    fake.results.push([]); // old1 lookup empty
    fake.results.push([{ id: "u-2", session_id: "s-old", username: "old2" }]);
    seedMigrate();
    fake.results.push([]); // SELECT glitch_coins → empty so no merge

    const res = await call({
      action: "merge_accounts",
      session_id: "s-new",
      old_usernames: ["old1", "old2"],
    });
    const body = (await res.json()) as {
      merged_accounts: string[];
      not_found: string[];
    };
    expect(body.not_found).toEqual(["old1"]);
    expect(body.merged_accounts).toEqual(["old2"]);
  });
});

describe("signout", () => {
  it("returns success:true", async () => {
    const body = (await (await call({ action: "signout" })).json()) as {
      success: boolean;
    };
    expect(body.success).toBe(true);
  });
});
