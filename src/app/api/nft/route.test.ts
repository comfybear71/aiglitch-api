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

async function callGet(query = "") {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/nft${query}`, {
    method: "GET",
  });
  return mod.GET(req);
}

async function callPost() {
  vi.resetModules();
  const mod = await import("./route");
  return mod.POST();
}

describe("GET /api/nft ?action=collection_stats", () => {
  it("returns aggregate stats + revenue block", async () => {
    fake.results.push([{ count: "12" }]); // totalMinted
    fake.results.push([
      { rarity: "common", count: "8" },
      { rarity: "legendary", count: "4" },
    ]); // byRarity
    fake.results.push([
      {
        product_name: "Widget",
        product_emoji: "🧩",
        mint_address: "mintA",
        rarity: "common",
        owner_type: "human",
        mint_tx_hash: "tx1",
        created_at: "2026-04-21",
      },
    ]); // recentMints
    fake.results.push([
      { total: "100", persona: "40" },
    ]); // revenue

    const res = await callGet("?action=collection_stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_minted: number;
      collection: string;
      contract: string;
      rarity_breakdown: unknown[];
      recent_mints: unknown[];
      revenue: {
        total_glitch: number;
        total_persona_earnings: number;
        treasury_share: number;
      };
    };
    expect(body.total_minted).toBe(12);
    expect(body.collection).toContain("AIG!itch");
    expect(body.contract).toBeTruthy();
    expect(body.rarity_breakdown).toHaveLength(2);
    expect(body.recent_mints).toHaveLength(1);
    expect(body.revenue.total_glitch).toBe(100);
    expect(body.revenue.total_persona_earnings).toBe(40);
    expect(body.revenue.treasury_share).toBe(60);
  });

  it("gracefully handles missing marketplace_revenue table", async () => {
    fake.results.push([{ count: "3" }]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push(new Error("relation marketplace_revenue does not exist"));

    const res = await callGet("?action=collection_stats");
    const body = (await res.json()) as {
      total_minted: number;
      revenue: { total_glitch: number; total_persona_earnings: number };
    };
    expect(body.total_minted).toBe(3);
    expect(body.revenue.total_glitch).toBe(0);
    expect(body.revenue.total_persona_earnings).toBe(0);
  });
});

describe("GET /api/nft ?action=supply", () => {
  it("returns supply map with max_per_product", async () => {
    fake.results.push([
      { product_id: "widget", minted: "5" },
      { product_id: "gadget", minted: "12" },
    ]);
    const res = await callGet("?action=supply");
    const body = (await res.json()) as {
      supply: Record<string, number>;
      max_per_product: number;
    };
    expect(body.supply.widget).toBe(5);
    expect(body.supply.gadget).toBe(12);
    expect(body.max_per_product).toBe(100);
  });
});

describe("GET /api/nft default listing", () => {
  it("returns empty nfts when session_id missing", async () => {
    const res = await callGet("");
    const body = (await res.json()) as { nfts: unknown[] };
    expect(body.nfts).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("wallet-linked user → fallback query includes wallet-address clause", async () => {
    fake.results.push([
      { phantom_wallet_address: "wallet-abc" },
    ]); // user lookup
    fake.results.push([
      { id: "nft-1", product_name: "Widget" },
    ]); // NFTs via wallet-address fallback
    fake.results.push([]); // auto-repair UPDATE

    const res = await callGet("?session_id=sess-new");
    const body = (await res.json()) as { nfts: unknown[] };
    expect(body.nfts).toHaveLength(1);

    // Verify the NFT query went through the wallet-fallback path
    const nftQuery = fake.calls.find((c) =>
      c.strings.join("?").includes("phantom_wallet_address"),
    );
    expect(nftQuery).toBeDefined();

    // Auto-repair UPDATE fired
    const repair = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE minted_nfts"),
    );
    expect(repair).toBeDefined();
  });

  it("no wallet address → direct session_id query", async () => {
    fake.results.push([{ phantom_wallet_address: null }]);
    fake.results.push([{ id: "nft-1" }]);
    fake.results.push([]); // auto-repair

    await callGet("?session_id=sess-x");
    const nftQuery = fake.calls[1]!;
    expect(nftQuery.strings.join("?")).not.toContain("phantom_wallet_address");
    expect(nftQuery.strings.join("?")).toContain("owner_type");
  });

  it("user lookup failure still proceeds with direct session query", async () => {
    fake.results.push(new Error("DB glitch"));
    fake.results.push([]); // NFT query (no wallet fallback)

    const res = await callGet("?session_id=sess-x");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nfts: unknown[] };
    expect(body.nfts).toEqual([]);
  });

  it("auto-repair failure is swallowed — response still contains NFTs", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([{ id: "nft-1" }]);
    fake.results.push(new Error("repair failed"));

    const res = await callGet("?session_id=sess-new");
    const body = (await res.json()) as { nfts: { id: string }[] };
    expect(body.nfts).toHaveLength(1);
    expect(body.nfts[0]!.id).toBe("nft-1");
  });

  it("no NFTs → no auto-repair attempted", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([]); // no NFTs

    await callGet("?session_id=sess-new");
    const repair = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE minted_nfts"),
    );
    expect(repair).toBeUndefined();
  });
});

describe("POST /api/nft", () => {
  it("returns 410 Gone with marketplace redirect", async () => {
    const res = await callPost();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; redirect: string };
    expect(body.error).toContain("marketplace");
    expect(body.redirect).toBe("/marketplace");
  });
});
