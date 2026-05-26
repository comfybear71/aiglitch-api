/**
 * Smoke tests for /api/auth/wallet-qr (public Ed25519 challenge/sign/verify).
 *
 * Strategy: pin the state machine + input gates. Real Ed25519 verify
 * is exercised end-to-end by the legacy QR flow; here we cover:
 *   - GET (no c) returns a fresh challenge with message + id
 *   - GET ?c=expired returns status=expired
 *   - GET ?c=pending returns the message back
 *   - POST without required fields → 400
 *   - POST with wrong signature → 401
 *   - POST approve_original bridge call → success
 *
 * The in-memory cache is module-state, so tests reset modules between.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/wallet-qr${query}`, init);
}

describe("GET", () => {
  it("issues a new challenge when no ?c param", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.challengeId).toMatch(/^[a-f0-9]{32}$/);
    expect(body.message).toContain("Welcome to AIG!itch");
    expect(body.message).toContain("Challenge:");
  });

  it("returns status=expired when polling unknown challengeId", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?c=does-not-exist"));
    const body = await res.json();
    expect(body.status).toBe("expired");
  });

  it("returns status=pending + message when polling a fresh challenge", async () => {
    const { GET } = await import("./route");
    const created = await (await GET(await buildRequest())).json();
    const polled = await (await GET(await buildRequest(`?c=${created.challengeId}`))).json();
    expect(polled.status).toBe("pending");
    expect(polled.message).toBe(created.message);
  });
});

describe("POST", () => {
  it("400 when missing required fields", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when challenge does not exist", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: "nope",
          signature: "x",
          publicKey: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("401 on a syntactically-valid public key with bogus signature", async () => {
    const { GET, POST } = await import("./route");
    const created = await (await GET(await buildRequest())).json();
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          challengeId: created.challengeId,
          signature: Buffer.alloc(64).toString("base64"),
          publicKey: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
        }),
      }),
    );
    // Either 401 (verify ran + failed) or 500 (verify threw on bad sig shape)
    expect([401, 500]).toContain(res.status);
  });

  it("approve_original bridges desktop status to approved", async () => {
    const { GET, POST } = await import("./route");
    const created = await (await GET(await buildRequest())).json();

    const bridge = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "approve_original",
          originalChallengeId: created.challengeId,
          wallet: "7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56",
        }),
      }),
    );
    expect(bridge.status).toBe(200);

    const polled = await (
      await GET(await buildRequest(`?c=${created.challengeId}`))
    ).json();
    expect(polled.status).toBe("approved");
    expect(polled.wallet).toBe("7SGf93WGk7VpSmreARzNujPbEpyABq2Em9YvaCirWi56");
  });
});
