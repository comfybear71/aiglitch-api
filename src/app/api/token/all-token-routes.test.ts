/**
 * Smoke tests for the six /api/token/* routes.
 *
 * These endpoints are pure static JSON / SVG / 302 — no DB, no auth,
 * no inputs. One consolidated file covers all six because the tests
 * collapse to "status + content-type + cache-control + a couple of
 * key fields".
 */

import { describe, expect, it } from "vitest";

async function importRoute(path: string) {
  return (await import(path)) as { GET: (...args: unknown[]) => Promise<Response> };
}

describe("GET /api/token/metadata", () => {
  it("returns Metaplex metadata with §GLITCH branding + logo URIs", async () => {
    const { GET } = await importRoute("./metadata/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = (await res.json()) as {
      name: string;
      symbol: string;
      mint: string;
      decimals: number;
      chainId: number;
      image: string;
      logoURI: string;
      properties: { files: Array<{ uri: string; type: string }> };
      extensions: { coingeckoId: string };
    };
    expect(body.name).toBe("AIG!itch");
    expect(body.symbol).toBe("GLITCH");
    expect(body.decimals).toBe(9);
    expect(body.chainId).toBe(101);
    expect(body.mint).toBe("5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT");
    expect(body.image).toContain("/api/token/logo");
    expect(body.logoURI).toContain("/api/token/logo");
    expect(body.properties.files).toHaveLength(2);
    expect(body.extensions.coingeckoId).toBe("aiglitch");
  });
});

describe("GET /api/token/logo", () => {
  it("returns SVG with correct content type + long public cache", async () => {
    const { GET } = await importRoute("./logo/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=604800",
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("§GLITCH");
  });
});

describe("GET /api/token/logo.png", () => {
  it("302 redirects to /api/token/logo", async () => {
    const { GET } = await importRoute("./logo.png/route");
    const res = await GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/api/token/logo");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });
});

describe("GET /api/token/token-list", () => {
  it("returns Jupiter-compatible token list", async () => {
    const { GET } = await importRoute("./token-list/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    );

    const body = (await res.json()) as {
      name: string;
      tokens: Array<{
        chainId: number;
        address: string;
        symbol: string;
        decimals: number;
      }>;
      version: { major: number };
      timestamp: string;
    };
    expect(body.name).toBe("AIG!itch Token List");
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.chainId).toBe(101);
    expect(body.tokens[0]?.symbol).toBe("GLITCH");
    expect(body.tokens[0]?.decimals).toBe(9);
    expect(body.version.major).toBe(1);
    // timestamp is a recent ISO string
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });
});

describe("GET /api/token/verification", () => {
  it("returns the admin reference bundle with no-cache", async () => {
    const { GET } = await importRoute("./verification/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    const body = (await res.json()) as {
      token: { mint: string; decimals: number };
      links: { metadata_json: string };
      explorers: { solscan: string };
      dex: { meteoraPool: string; meteoraPoolAddress: string };
      wallets: { treasury: string; admin: string };
      submissionGuides: {
        jupiter: { steps: string[] };
        coingecko: { url: string };
        coinmarketcap: { steps: string[] };
        dexscreener: { steps: string[] };
        birdeye: { steps: string[] };
      };
    };
    expect(body.token.mint).toBe("5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT");
    expect(body.token.decimals).toBe(9);
    expect(body.links.metadata_json).toContain("/api/token/metadata");
    expect(body.explorers.solscan).toContain("solscan.io/token/");
    expect(body.dex.meteoraPoolAddress).toBe(
      "GWBsH6aArjdwmX8zUaiPdDke1nA7pLLe9x9b1kuHpsGV",
    );
    expect(body.wallets.treasury).toBe("7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56");
    expect(body.wallets.admin).toBe("2J2XWm3oZo9JUu6i5ceAsoDmeFZw5trBhjdfm2G72uTJ");
    // All five submission guides present
    expect(body.submissionGuides.jupiter.steps.length).toBeGreaterThan(0);
    expect(body.submissionGuides.coingecko.url).toContain("coingecko.com");
    expect(body.submissionGuides.coinmarketcap.steps.length).toBeGreaterThan(0);
    expect(body.submissionGuides.dexscreener.steps.length).toBeGreaterThan(0);
    expect(body.submissionGuides.birdeye.steps.length).toBeGreaterThan(0);
  });
});

describe("GET /api/token/dexscreener", () => {
  async function callGet(query = "") {
    const { GET } = await importRoute("./dexscreener/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost/api/token/dexscreener${query}`);
    return GET(req as unknown as Request);
  }

  it("returns the GLITCH DexScreener token info by default", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400",
    );
    const body = (await res.json()) as Array<{
      chainId: string;
      tokenAddress: string;
      links: Array<{ type: string; url: string }>;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.chainId).toBe("solana");
    expect(body[0]?.tokenAddress).toBe("5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT");
    const linkTypes = body[0]?.links.map((l) => l.type) ?? [];
    expect(linkTypes).toContain("website");
    expect(linkTypes).toContain("purchase");
    expect(linkTypes).toContain("explorer");
  });

  it("?tokenAddresses including GLITCH returns the token info", async () => {
    const res = await callGet(
      "?tokenAddresses=5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT,FooFoo123",
    );
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });

  it("?tokenAddresses without GLITCH returns []", async () => {
    const res = await callGet("?tokenAddresses=SomeOtherMint,AnotherMint");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("trims whitespace in the tokenAddresses list", async () => {
    const res = await callGet(
      "?tokenAddresses=%20%205hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT%20%20,Foo",
    );
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });
});
