/**
 * Smoke tests for /api/wallet/verify — Ed25519 signature challenge flow.
 *
 * The crypto verify logic lives in `@/lib/wallet-verify`; here we just
 * verify the route gates GET on basic input shape and POST on the
 * challenge / signature pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = { calls: [] as SqlCall[], results: [] as unknown[][] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/wallet-verify", () => ({
  generateChallenge: vi.fn(),
  verifyWalletSignature: vi.fn(),
  isChallengeValid: vi.fn(),
}));

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

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/wallet/verify${query}`, init);
}

describe("GET", () => {
  it("400 on missing wallet param", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(400);
  });

  it("400 on too-short wallet", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?wallet=short"));
    expect(res.status).toBe(400);
  });

  it("200 + challenge payload for valid-length wallet", async () => {
    const { generateChallenge } = await import("@/lib/wallet-verify");
    (generateChallenge as ReturnType<typeof vi.fn>).mockReturnValue({
      challenge: "Verify wallet ownership: 7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56 :: 12345",
      expires_at: Date.now() + 300000,
    });

    const { GET } = await import("./route");
    const res = await GET(
      await buildRequest("?wallet=7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.challenge).toContain("Verify wallet ownership");
  });
});

describe("POST", () => {
  it("400 on missing required fields", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ session_id: "s1" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("410 on expired challenge", async () => {
    const { isChallengeValid } = await import("@/lib/wallet-verify");
    (isChallengeValid as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          wallet_address: "abc",
          signature: "sig",
          message: "old-challenge",
        }),
      }),
    );
    expect(res.status).toBe(410);
  });

  it("401 on bad signature", async () => {
    const { isChallengeValid, verifyWalletSignature } = await import(
      "@/lib/wallet-verify"
    );
    (isChallengeValid as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (verifyWalletSignature as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          wallet_address: "abc",
          signature: "bad-sig",
          message: "valid-challenge",
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("200 + binds wallet on valid signature", async () => {
    const { isChallengeValid, verifyWalletSignature } = await import(
      "@/lib/wallet-verify"
    );
    (isChallengeValid as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (verifyWalletSignature as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    fake.results = [[]]; // UPDATE returns nothing

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          session_id: "s1",
          wallet_address: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
          signature: "sig",
          message: "challenge",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(fake.calls.length).toBeGreaterThan(0); // hit the DB UPDATE
  });
});
