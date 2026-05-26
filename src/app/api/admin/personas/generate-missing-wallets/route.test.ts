/**
 * Tests for /api/admin/personas/generate-missing-wallets.
 *
 * Critical surface — system-custodial of persona keypairs. We pin:
 *   - Auth gate (401 without admin)
 *   - Response NEVER includes private/encrypted key material (verified
 *     by asserting it doesn't leak into any field client-side)
 *   - Single-mode: not_found, already_exists, created happy path, db_error
 *   - Batch mode: created + errors aggregation
 *
 * @solana/web3.js Keypair.generate() is real (deterministic via
 * crypto seed) — tests don't mock it because the encryptKeypair byte
 * layout is part of the cross-route contract that other routes depend on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
  throwOnNextInsert: false,
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const sql = strings.raw.join("");
  if (fake.throwOnNextInsert && sql.includes("INSERT INTO budju_wallets")) {
    fake.throwOnNextInsert = false;
    return Promise.reject(new Error("simulated db failure"));
  }
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: vi.fn(),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  fake.throwOnNextInsert = false;
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
  return new NextRequest(
    "http://localhost/api/admin/personas/generate-missing-wallets",
    init,
  );
}

describe("GET — list personas missing a wallet", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
  });

  it("returns active personas without budju_wallets row", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[
      { id: "p1", username: "alice", display_name: "Alice", avatar_emoji: "🦊" },
      { id: "p2", username: "bob",   display_name: "Bob",   avatar_emoji: "🐢" },
    ]];

    const { GET } = await import("./route");
    const res = await GET(await buildRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.personas).toHaveLength(2);

    // Response must not leak private/encrypted key material.
    for (const p of body.personas) {
      expect(p).not.toHaveProperty("encrypted_keypair");
      expect(p).not.toHaveProperty("secretKey");
      expect(p).not.toHaveProperty("privateKey");
    }
  });
});

describe("POST — single persona mode", () => {
  it("401 when not admin", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("404 when persona doesn't exist / is inactive", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[]]; // SELECT persona → empty

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "ghost" }) }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("not_found");
  });

  it("returns already_exists when persona already has a wallet (idempotent)", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice" }],
      [{ id: "w1", wallet_address: "WaLLeTaDdReSs11111111111111111111111111111" }],
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("already_exists");
    expect(body.wallet_address).toBe("WaLLeTaDdReSs11111111111111111111111111111");

    // Should NOT have hit any INSERT.
    expect(
      fake.calls.some((c) => c.strings.raw.join("").includes("INSERT INTO budju_wallets")),
    ).toBe(false);
  });

  it("happy path: creates wallet + returns ONLY safe fields", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice" }], // persona
      [],                                                          // no existing wallet
      [{ cnt: 0 }],                                                // wallet count
      [],                                                          // INSERT
    ];

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("created");
    expect(body.wallet_address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    // CRITICAL: response must not include the secret key or its encrypted form.
    expect(JSON.stringify(body)).not.toMatch(/secretKey|encrypted_keypair|privateKey/i);

    // INSERT row must include the encrypted_keypair (we verify by snooping
    // the captured call values include a bs58-shaped string distinct from
    // the wallet_address).
    const insert = fake.calls.find((c) =>
      c.strings.raw.join("").includes("INSERT INTO budju_wallets"),
    );
    expect(insert).toBeDefined();
    const values = insert!.values as string[];
    const encryptedKey = values.find(
      (v) => typeof v === "string" && v.length > 40 && v !== body.wallet_address,
    );
    expect(encryptedKey).toBeTruthy(); // encrypted key WAS stored
  });

  it("returns status=failed when INSERT throws", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [{ id: "p1", username: "alice", display_name: "Alice" }],
      [],
      [{ cnt: 0 }],
    ];
    fake.throwOnNextInsert = true;

    const { POST } = await import("./route");
    const res = await POST(
      await buildRequest({ method: "POST", body: JSON.stringify({ persona_id: "p1" }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/simulated db failure/);
  });
});

describe("POST — batch mode (no persona_id)", () => {
  it("creates wallets for every missing persona + aggregates", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      // SELECT personas missing wallets
      [
        { id: "p1", username: "alice" },
        { id: "p2", username: "bob" },
      ],
      // wallet count
      [{ cnt: 5 }],
      // INSERT p1
      [],
      // INSERT p2
      [],
    ];

    const { POST } = await import("./route");
    const res = await POST(await buildRequest({ method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.created).toBe(2);
    expect(body.errors).toBe(0);
    expect(body.details.created).toHaveLength(2);
    expect(body.details.created[0].wallet_address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("continues batch through individual failures", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [
      [
        { id: "p1", username: "alice" },
        { id: "p2", username: "bob" },
      ],
      [{ cnt: 0 }],
    ];
    fake.throwOnNextInsert = true; // first INSERT fails

    const { POST } = await import("./route");
    const res = await POST(await buildRequest({ method: "POST", body: "{}" }));
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.created).toBe(1);
    expect(body.errors).toBe(1);
    expect(body.details.errors[0].persona_id).toBe("p1");
  });

  it("returns 0/0 cleanly when no personas missing wallets", async () => {
    const { isAdminAuthenticated } = await import("@/lib/admin-auth");
    (isAdminAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fake.results = [[], [{ cnt: 100 }]];

    const { POST } = await import("./route");
    const res = await POST(await buildRequest({ method: "POST", body: "{}" }));
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.created).toBe(0);
    expect(body.errors).toBe(0);
  });
});
