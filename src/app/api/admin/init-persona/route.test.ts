/**
 * Tests for /api/admin/init-persona.
 *
 * Critical surface — system-custodial persona setup. We pin:
 *   - Auth gate
 *   - Response NEVER leaks private/encrypted keys
 *   - Persona-not-found returns 404 with seed hint (behaviour change vs legacy)
 *   - Skip flags work independently
 *   - Wallet step is idempotent (no double-create if wallet exists)
 *   - Avatar failure surfaces as a warning, doesn't fail the whole request
 *   - Default avatar prompt builder shape
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));
vi.mock("@/lib/cache", () => ({
  cache: { del: vi.fn(), get: vi.fn(), set: vi.fn() },
}));
vi.mock("@/lib/repositories/users", () => ({
  awardPersonaCoins: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: vi.fn(),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.BUDJU_WALLET_SECRET = "test-secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.BUDJU_WALLET_SECRET;
});

async function buildRequest(init?: { method?: string; body?: string }) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/admin/init-persona", init);
}

describe("POST /api/admin/init-persona auth + validation", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("400 when persona_id missing", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("404 with seed hint when persona not in DB", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[]]; // SELECT ai_personas → empty

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "ghost" }) }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/);
    expect(body.hint).toMatch(/SEED_PERSONAS/);
  });
});

describe("POST /api/admin/init-persona happy paths", () => {
  it("full run: glitch + wallet + avatar all complete, no key leak", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { generateImageToBlob } = await import("@/lib/ai/image");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (generateImageToBlob as ReturnType<typeof vi.fn>).mockResolvedValue({
      blobUrl: "https://blob/avatars/test.png",
      model: "grok-imagine-image-pro",
      estimatedUsd: 0.07,
    });

    fake.results = [
      // Step 1: SELECT persona
      [{ id: "p1", username: "alice", display_name: "Alice", avatar_url: null }],
      // Step 4: SELECT existing wallet → none
      [],
      // Step 4: SELECT count
      [{ cnt: 0 }],
      // Step 4: INSERT wallet
      [],
      // Step 5: SELECT persona for prompt
      [{
        id: "p1", username: "alice", display_name: "Alice",
        bio: "Friend of all", personality: "kind + curious", avatar_url: null,
      }],
      // Step 5: UPDATE avatar_url
      [],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.steps).toContain("persona_exists: alice");
    expect(body.steps).toContain("cache_invalidated: personas:active");
    expect(body.steps).toContain("glitch_awarded: 1000");
    expect(body.wallet_address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(body.avatar_url).toBe("https://blob/avatars/test.png");
    expect(body.avatar_source).toBe("grok-aurora");

    // CRITICAL: no key material in response
    expect(JSON.stringify(body)).not.toMatch(/secretKey|encrypted_keypair|privateKey/i);
  });

  it("idempotent wallet step: returns existing wallet instead of creating new", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice", avatar_url: null }],
      [{ id: "w1", wallet_address: "ExistingWaLLet111111111111111111111111111111" }],
      // skip_avatar will bypass step 5
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ persona_id: "p1", skip_avatar: true }),
      }),
    );
    const body = await res.json();

    expect(body.wallet_address).toBe("ExistingWaLLet111111111111111111111111111111");
    expect(body.steps).toContain(`wallet_exists: ExistingWaLLet111111111111111111111111111111`);
    expect(body.steps).toContain("avatar_skipped");

    // Should NOT have hit INSERT
    expect(
      fake.calls.some((c) => c.strings.raw.join("").includes("INSERT INTO budju_wallets")),
    ).toBe(false);
  });

  it("skip flags work independently", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice", avatar_url: null }],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({
          persona_id: "p1",
          skip_glitch: true,
          skip_wallet: true,
          skip_avatar: true,
        }),
      }),
    );
    const body = await res.json();

    expect(body.steps).toContain("glitch_skipped");
    expect(body.steps).toContain("wallet_skipped");
    expect(body.steps).toContain("avatar_skipped");
    expect(body).not.toHaveProperty("wallet_address");
    expect(body).not.toHaveProperty("avatar_url");
  });

  it("avatar failure surfaces as warning, doesn't fail whole request", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { generateImageToBlob } = await import("@/lib/ai/image");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (generateImageToBlob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("xAI circuit breaker is OPEN"),
    );

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice", avatar_url: null }],
      [{ id: "w1", wallet_address: "ExistingWaLLet111111111111111111111111111111" }],
      [{ id: "p1", username: "alice", display_name: "Alice", bio: "x", personality: "y", avatar_url: null }],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({ persona_id: "p1", skip_glitch: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(
      (body.warnings as string[]).some((w) => w.includes("avatar generation failed")),
    ).toBe(true);
    expect(body).not.toHaveProperty("avatar_url");
  });

  it("custom avatar_prompt is used when provided", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    const { generateImageToBlob } = await import("@/lib/ai/image");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (generateImageToBlob as ReturnType<typeof vi.fn>).mockResolvedValue({
      blobUrl: "https://blob/x.png",
      model: "grok-imagine-image-pro",
      estimatedUsd: 0.07,
    });

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice", avatar_url: null }],
      [{ id: "w1", wallet_address: "WaLLeT1111111111111111111111111111111111111" }],
      [{ id: "p1", username: "alice", display_name: "Alice", bio: "x", personality: "y", avatar_url: null }],
      [],
    ];

    const customPrompt = "A cyberpunk fox with neon glasses";
    const { POST } = await import("./route");
    await POST(
      await buildRequest({
        method: "POST",
        body: JSON.stringify({
          persona_id: "p1",
          skip_glitch: true,
          avatar_prompt: customPrompt,
        }),
      }),
    );

    // mock.calls accumulates across tests in this file (the vi.mock factory
    // is module-level). Take the most-recent call, which corresponds to
    // this test's invocation.
    const calls = (generateImageToBlob as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.at(-1)?.[0];
    expect(call?.prompt).toBe(customPrompt);
  });
});
