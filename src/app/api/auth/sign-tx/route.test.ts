/**
 * Smoke tests for /api/auth/sign-tx (cross-device tx bridge).
 *
 * Strategy: pin the create_intent → build_and_sign → submit state
 * machine. The actual OTC swap call is mocked via fetch — we just
 * verify this orchestrator routes the right shape downstream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildRequest(query = "", init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/auth/sign-tx${query}`, init);
}

describe("GET", () => {
  it("400 without t param", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(400);
  });

  it("status=expired for unknown txId", async () => {
    const { GET } = await import("./route");
    const res = await GET(await buildRequest("?t=does-not-exist"));
    const body = await res.json();
    expect(body.status).toBe("expired");
  });
});

describe("POST create_intent", () => {
  it("400 without wallet + glitch_amount", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "create_intent", wallet: "abc" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns a txId that can be polled", async () => {
    const { GET, POST } = await import("./route");
    const created = await (
      await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "create_intent",
            wallet: "ABC",
            glitch_amount: 100,
            description: "Test buy",
          }),
        }),
      )
    ).json();
    expect(created.txId).toMatch(/^[a-f0-9]{32}$/);

    const polled = await (await GET(await buildRequest(`?t=${created.txId}`))).json();
    expect(polled.status).toBe("pending");
    expect(polled.wallet).toBe("ABC");
    expect(polled.glitch_amount).toBe(100);
  });
});

describe("POST build_and_sign", () => {
  it("404 when txId expired/unknown", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "build_and_sign", txId: "nope" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("relays freshly built tx from /api/otc-swap and stores swap_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          success: true,
          swap_id: "swap-123",
          transaction: "base64-tx",
        }),
      })),
    );

    const { POST } = await import("./route");
    const created = await (
      await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "create_intent",
            wallet: "ABC",
            glitch_amount: 100,
          }),
        }),
      )
    ).json();

    const signed = await (
      await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({ action: "build_and_sign", txId: created.txId }),
        }),
      )
    ).json();

    expect(signed.success).toBe(true);
    expect(signed.swap_id).toBe("swap-123");
    expect(signed.transaction).toBe("base64-tx");
  });

  it("400 + persists failed status when downstream swap fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ success: false, error: "treasury_drained" }),
      })),
    );

    const { GET, POST } = await import("./route");
    const created = await (
      await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "create_intent",
            wallet: "ABC",
            glitch_amount: 100,
          }),
        }),
      )
    ).json();

    const failed = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({ action: "build_and_sign", txId: created.txId }),
      }),
    );
    expect(failed.status).toBe(400);

    const polled = await (
      await GET(await buildRequest(`?t=${created.txId}&poll=1`))
    ).json();
    expect(polled.status).toBe("failed");
  });
});

describe("POST submit", () => {
  it("400 if build_and_sign hasn't run yet", async () => {
    const { POST } = await import("./route");
    const created = await (
      await POST(
        await buildRequest("", {
          method: "POST",
          body: JSON.stringify({
            action: "create_intent",
            wallet: "ABC",
            glitch_amount: 100,
          }),
        }),
      )
    ).json();

    const submitted = await POST(
      await buildRequest("", {
        method: "POST",
        body: JSON.stringify({
          action: "submit",
          txId: created.txId,
          signed_transaction: "user-signed-tx",
        }),
      }),
    );
    expect(submitted.status).toBe(400);
    const body = await submitted.json();
    expect(body.error).toMatch(/swap_id/);
  });
});

it("400 on unknown action", async () => {
  const { POST } = await import("./route");
  const res = await POST(
    await buildRequest("", {
      method: "POST",
      body: JSON.stringify({ action: "banana" }),
    }),
  );
  expect(res.status).toBe(400);
});
