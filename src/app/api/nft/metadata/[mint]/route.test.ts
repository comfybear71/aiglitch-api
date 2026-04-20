/**
 * Integration tests for GET /api/nft/metadata/[mint].
 *
 * - 400 Missing mint
 * - 404 NFT not found when minted_nfts lookup empty
 * - Marketplace branch: full Metaplex shape with rarity, category,
 *   price, edition info, CORS-friendly Cache-Control
 * - Persona branch: product_id starts with "persona:" → AI Bestie
 *   metadata with persona bio in description
 * - 500 wrapping on unexpected DB error
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

async function callGet(mint: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/nft/metadata/${mint}`);
  return GET(req, { params: Promise.resolve({ mint }) });
}

describe("GET /api/nft/metadata/[mint]", () => {
  it("400 when mint is empty string", async () => {
    const res = await callGet("");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing mint address");
  });

  it("404 when minted_nfts lookup empty", async () => {
    fake.results = [[]];
    const res = await callGet("SomeMintAddress111111");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NFT not found");
  });

  it("marketplace branch returns Metaplex shape with rarity + edition", async () => {
    fake.results = [
      [
        {
          product_id: "prod-001",
          product_name: "The Upside Down Cup™",
          product_emoji: "🥤",
          rarity: null, // fall through to getRarity(price)
          mint_cost_glitch: 50,
          edition_number: 7,
          max_supply: 100,
          generation: 2,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
    ];
    const res = await callGet("MintABC");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    );
    const body = (await res.json()) as {
      name: string;
      symbol: string;
      image: string;
      attributes: Array<{ trait_type: string; value: string | number }>;
      collection: { name: string; family: string };
    };
    expect(body.symbol).toBe("AIG");
    expect(body.name).toContain("#7");
    expect(body.image).toContain("/api/nft/image/prod-001");
    const byKey = Object.fromEntries(
      body.attributes.map((a) => [a.trait_type, a.value]),
    );
    expect(byKey.Category).toBe("Home & Useless");
    expect(byKey["Edition"]).toBe("7/100");
    expect(byKey["Generation"]).toBe(2);
    expect(byKey.Collection).toBe("AIG!itch Marketplace NFTs");
    expect(body.collection.family).toBe("AIG!itch");
  });

  it("marketplace branch uses DB rarity when present", async () => {
    fake.results = [
      [
        {
          product_id: "prod-001",
          product_name: "X",
          product_emoji: "🥤",
          rarity: "legendary",
          mint_cost_glitch: 10, // low price but rarity overrides
          edition_number: null,
          max_supply: null,
          generation: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
    ];
    const res = await callGet("M");
    const body = (await res.json()) as {
      attributes: Array<{ trait_type: string; value: string | number }>;
    };
    const rarityAttr = body.attributes.find((a) => a.trait_type === "Rarity");
    expect(rarityAttr?.value).toBe("Legendary");
  });

  it("persona branch returns AI Bestie metadata with persona bio", async () => {
    fake.results = [
      [
        {
          product_id: "persona:glitch-042",
          product_name: "Alice the Bestie",
          product_emoji: "🤖",
          rarity: null,
          mint_cost_glitch: 1000,
          edition_number: null,
          max_supply: null,
          generation: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
      [
        {
          username: "alice_ai",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: "https://cdn/alice.png",
          persona_type: "general",
          bio: "Very smart bestie who loves long walks on the beach.",
          owner_wallet_address: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
    ];
    const res = await callGet("PersonaMint");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      symbol: string;
      image: string;
      description: string;
      attributes: Array<{ trait_type: string; value: string }>;
      collection: { name: string };
    };
    expect(body.symbol).toBe("AIGB");
    expect(body.name).toBe("Alice");
    expect(body.image).toBe("https://cdn/alice.png"); // persona avatar_url wins
    expect(body.description).toContain("Alice");
    expect(body.description).toContain("@alice_ai");
    expect(body.description).toContain("Very smart bestie");
    expect(body.collection.name).toBe("AIG!itch AI Besties");
    const rarityAttr = body.attributes.find((a) => a.trait_type === "Rarity");
    expect(rarityAttr?.value).toBe("Legendary");
  });

  it("persona branch falls back to generated image URL when no avatar_url", async () => {
    fake.results = [
      [
        {
          product_id: "persona:glitch-042",
          product_name: "X",
          product_emoji: "🤖",
          rarity: null,
          mint_cost_glitch: 1000,
          edition_number: null,
          max_supply: null,
          generation: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
      [
        {
          username: "alice_ai",
          display_name: "Alice",
          avatar_emoji: "🤖",
          avatar_url: null,
          persona_type: "general",
          bio: "b",
          owner_wallet_address: null,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
    ];
    const res = await callGet("PersonaMint2");
    const body = (await res.json()) as { image: string };
    expect(body.image).toContain("/api/nft/image/persona-glitch-042");
  });

  it("500 wrapping on DB error", async () => {
    fake.throwOnNextCall = new Error("pg down");
    const res = await callGet("AnyMint");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("Failed to load NFT metadata");
    expect(body.detail).toBe("pg down");
  });
});
