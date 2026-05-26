/**
 * Smoke tests for /api/hatch.
 *
 * The full hatch flow is a streaming SSE-style endpoint with AI image
 * + video generation; that's a devnet smoke test, not a unit one.
 * Here we cover the synchronous gates:
 *   - GET wallet-status lookups
 *   - POST 400/403 input gates
 *   - prepare_nft_mint 500 when TREASURY_PRIVATE_KEY is unset
 *   - submit_payment / submit_nft_mint missing-field gates
 *   - "already hatched" 409 on the main hatch flow
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/ai/image", () => ({ generateImageToBlob: vi.fn() }));
vi.mock("@/lib/ai/video", () => ({ generateVideoToBlob: vi.fn() }));
vi.mock("@/lib/ai/generate", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/repositories/users", () => ({ awardPersonaCoins: vi.fn() }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.TREASURY_PRIVATE_KEY;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/hatch${query}`, init);
}

describe("GET", () => {
  it("400 without session_id", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(400);
  });

  it("wallet_connected:false when user has no phantom_wallet_address", async () => {
    fake.results = [[{ phantom_wallet_address: null }]];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?session_id=s1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_persona).toBe(false);
    expect(body.wallet_connected).toBe(false);
  });

  it("returns persona payload when wallet has one", async () => {
    fake.results = [
      [{ phantom_wallet_address: "WALLET" }], // user lookup
      [{ id: "p1", username: "bestie", display_name: "Best" }], // persona lookup
      [{ id: "b1", bot_username: "bestiebot", is_active: true }], // telegram bot
    ];
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?session_id=s1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_persona).toBe(true);
    expect(body.wallet_connected).toBe(true);
    expect(body.persona.username).toBe("bestie");
    expect(body.telegram_bot.bot_username).toBe("bestiebot");
  });
});

describe("POST input gates", () => {
  it("400 without session_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: "{not-json" }),
    );
    expect(res.status).toBe(400);
  });

  it("403 when user wallet not connected", async () => {
    fake.results = [
      [{ id: "u1", phantom_wallet_address: null, session_id: "s1" }],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "prepare_payment" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST prepare_nft_mint", () => {
  beforeEach(() => {
    fake.results = [
      [{ id: "u1", phantom_wallet_address: "WALLET", session_id: "s1" }],
    ];
  });

  it("400 without persona_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "prepare_nft_mint" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("500 when TREASURY_PRIVATE_KEY is unset", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "prepare_nft_mint",
          persona_id: "p1",
        }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Treasury key/i);
  });
});

describe("POST submit_payment + submit_nft_mint", () => {
  beforeEach(() => {
    fake.results = [
      [{ id: "u1", phantom_wallet_address: "WALLET", session_id: "s1" }],
    ];
  });

  it("submit_payment 400 without payment_id or signed_transaction", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", action: "submit_payment" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("submit_nft_mint 400 without required fields", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          action: "submit_nft_mint",
          signed_transaction: "x",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST main hatch flow (early gates)", () => {
  it("400 when meatbag_name missing", async () => {
    fake.results = [
      [{ id: "u1", phantom_wallet_address: "WALLET", session_id: "s1" }],
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1", mode: "random" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("409 when wallet already has a persona", async () => {
    fake.results = [
      [{ id: "u1", phantom_wallet_address: "WALLET", session_id: "s1" }],
      [{ id: "existing-persona" }], // existing persona row
    ];
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          mode: "random",
          meatbag_name: "Stuart",
          payment_tx: "tx-sig",
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already have/i);
  });
});
