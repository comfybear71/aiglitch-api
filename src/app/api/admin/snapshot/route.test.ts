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

async function call(method: "GET" | "POST", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/snapshot${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

// ── GET: admin-gated actions ──────────────────────────────────────────

describe("GET /api/admin/snapshot — admin actions", () => {
  it("401 when not admin (list)", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("401 when not admin (detail)", async () => {
    expect((await call("GET", { query: "?action=detail&snapshot_id=s1" })).status).toBe(401);
  });

  it("401 when not admin (manifest)", async () => {
    expect((await call("GET", { query: "?action=manifest&snapshot_id=s1" })).status).toBe(401);
  });

  it("list: returns latest snapshots when admin", async () => {
    mockIsAdmin = true;
    fake.results = [[{ id: "s1", name: "April drop", total_holders: 5 }]];
    const res = await call("GET", { query: "?action=list" });
    const body = (await res.json()) as { snapshots: { id: string }[] };
    expect(body.snapshots).toHaveLength(1);
  });

  it("detail: 400 when snapshot_id missing", async () => {
    mockIsAdmin = true;
    expect((await call("GET", { query: "?action=detail" })).status).toBe(400);
  });

  it("detail: 404 when snapshot not found", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    expect((await call("GET", { query: "?action=detail&snapshot_id=s1" })).status).toBe(404);
  });

  it("detail: returns snapshot + entries + computed summary", async () => {
    mockIsAdmin = true;
    const snapshot = { id: "s1", name: "n", total_holders: 3 };
    const entries = [
      { id: "e1", holder_type: "human",      balance: 100, phantom_wallet: "wallet-1", claim_status: "pending" },
      { id: "e2", holder_type: "human",      balance: 50,  phantom_wallet: null,        claim_status: "pending" },
      { id: "e3", holder_type: "ai_persona", balance: 200, phantom_wallet: null,        claim_status: "claimed" },
    ];
    fake.results = [[snapshot], entries];

    const res = await call("GET", { query: "?action=detail&snapshot_id=s1" });
    const body = (await res.json()) as {
      summary: {
        total_holders: number;
        human_holders: number;
        ai_holders: number;
        with_phantom_wallet: number;
        total_glitch: number;
        total_claimed: number;
      };
    };
    expect(body.summary.total_holders).toBe(3);
    expect(body.summary.human_holders).toBe(2);
    expect(body.summary.ai_holders).toBe(1);
    expect(body.summary.with_phantom_wallet).toBe(1);
    expect(body.summary.total_glitch).toBe(350);
    expect(body.summary.total_claimed).toBe(1);
  });

  it("manifest: splits ready vs pending by wallet presence", async () => {
    mockIsAdmin = true;
    fake.results = [[
      { holder_type: "human",      holder_id: "s1", display_name: "A", phantom_wallet: "wallet-1", balance: 100 },
      { holder_type: "human",      holder_id: "s2", display_name: "B", phantom_wallet: null,        balance: 50  },
      { holder_type: "ai_persona", holder_id: "p1", display_name: "C", phantom_wallet: null,        balance: 200 },
    ]];
    const res = await call("GET", { query: "?action=manifest&snapshot_id=s1" });
    const body = (await res.json()) as {
      token: string;
      ready_to_airdrop: { amount: number }[];
      pending_wallet:   { amount: number }[];
      totals: { ready_amount: number; pending_amount: number; total_amount: number };
    };
    expect(body.token).toBe("§GLITCH");
    expect(body.ready_to_airdrop).toHaveLength(1);
    expect(body.pending_wallet).toHaveLength(2);
    expect(body.totals).toEqual({ ready_amount: 100, pending_amount: 250, total_amount: 350 });
  });

  it("unknown action returns 400", async () => {
    mockIsAdmin = true;
    expect((await call("GET", { query: "?action=mystery" })).status).toBe(400);
  });
});

// ── GET: user_status is public ────────────────────────────────────────

describe("GET /api/admin/snapshot?action=user_status (public)", () => {
  it("does NOT require admin auth", async () => {
    // mockIsAdmin stays false — should still succeed
    fake.results = [[{ id: "s1", name: "Latest", created_at: "2026-04-21" }], []];
    const res = await call("GET", { query: "?action=user_status&session_id=sess-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { has_snapshot: boolean; has_balance: boolean };
    expect(body.has_snapshot).toBe(true);
    expect(body.has_balance).toBe(false);
  });

  it("400 when session_id missing", async () => {
    expect((await call("GET", { query: "?action=user_status" })).status).toBe(400);
  });

  it("returns has_snapshot:false when no finalised snapshot exists", async () => {
    fake.results = [[]];
    const res = await call("GET", { query: "?action=user_status&session_id=sess-1" });
    const body = (await res.json()) as { has_snapshot: boolean };
    expect(body.has_snapshot).toBe(false);
  });

  it("returns balance + claim info when the user has an entry", async () => {
    fake.results = [
      [{ id: "s1", name: "Latest", created_at: "2026-04-21" }],
      [{
        snapshot_id:  "s1",
        holder_type:  "human",
        holder_id:    "sess-1",
        balance:      "500",
        lifetime_earned: "600",
        claim_status: "pending",
        phantom_wallet: "wallet-1",
      }],
      [{ status: "completed", tx_signature: "abc", created_at: "t1", completed_at: "t2" }],
    ];
    const res = await call("GET", { query: "?action=user_status&session_id=sess-1" });
    const body = (await res.json()) as {
      has_balance: boolean;
      balance: number;
      claim: { status: string; tx_signature: string } | null;
    };
    expect(body.has_balance).toBe(true);
    expect(body.balance).toBe(500);
    expect(body.claim?.status).toBe("completed");
  });
});

// ── POST: take_snapshot ───────────────────────────────────────────────

describe("POST /api/admin/snapshot — take_snapshot", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { body: { action: "take_snapshot" } })).status).toBe(401);
  });

  it("400 when action is missing or unknown", async () => {
    mockIsAdmin = true;
    expect((await call("POST", { body: {} })).status).toBe(400);
    expect((await call("POST", { body: { action: "nope" } })).status).toBe(400);
  });

  it("writes one entry per holder + finalises the snapshot", async () => {
    mockIsAdmin = true;
    fake.results = [
      // humans: 2 rows
      [
        { session_id: "s1", balance: 100, lifetime_earned: 100, display_name: "A", username: "a", phantom_wallet_address: "wallet-1" },
        { session_id: "s2", balance: 50,  lifetime_earned: 50,  display_name: null, username: null, phantom_wallet_address: null },
      ],
      // ai: 1 row
      [{ persona_id: "p1", balance: 200, lifetime_earned: 200, display_name: "C", username: "c" }],
      // 3 INSERT entries + 1 INSERT snapshot row
      [], [], [], [],
    ];
    const res = await call("POST", { body: { action: "take_snapshot", name: "April drop" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      total_holders: number;
      human_holders: number;
      ai_holders: number;
      total_supply_captured: number;
    };
    expect(body.success).toBe(true);
    expect(body.total_holders).toBe(3);
    expect(body.human_holders).toBe(2);
    expect(body.ai_holders).toBe(1);
    expect(body.total_supply_captured).toBe(350);
  });
});
