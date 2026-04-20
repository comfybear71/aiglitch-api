/**
 * Unit tests for admin-auth helpers (safeEqual, generateToken,
 * isAdminAuthenticated).
 *
 * `next/headers` cookies() is mocked via vi.mock so tests can inject
 * different cookie states without a real Next runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cookieStore = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
  }),
}));

beforeEach(() => {
  cookieStore = new Map();
  process.env.ADMIN_PASSWORD = "hunter2";
  delete process.env.ADMIN_WALLET;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_WALLET;
});

describe("safeEqual", () => {
  it("returns true for identical strings", async () => {
    const { safeEqual } = await import("./admin-auth");
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of equal length", async () => {
    const { safeEqual } = await import("./admin-auth");
    expect(safeEqual("abc", "xyz")).toBe(false);
  });

  it("returns false for strings of different lengths", async () => {
    const { safeEqual } = await import("./admin-auth");
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
  });

  it("returns false for non-string inputs", async () => {
    const { safeEqual } = await import("./admin-auth");
    expect(safeEqual("abc", 123 as unknown as string)).toBe(false);
    expect(safeEqual(null as unknown as string, "abc")).toBe(false);
  });
});

describe("generateToken", () => {
  it("is deterministic for the same password", async () => {
    const { generateToken } = await import("./admin-auth");
    expect(generateToken("hunter2")).toBe(generateToken("hunter2"));
  });

  it("changes when the password changes", async () => {
    const { generateToken } = await import("./admin-auth");
    expect(generateToken("hunter2")).not.toBe(generateToken("hunter3"));
  });

  it("is a 64-char hex string (SHA-256)", async () => {
    const { generateToken } = await import("./admin-auth");
    const token = generateToken("hunter2");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("isAdminAuthenticated — cookie path", () => {
  it("returns true when cookie matches the expected HMAC", async () => {
    const { ADMIN_COOKIE, generateToken, isAdminAuthenticated } = await import(
      "./admin-auth"
    );
    cookieStore.set(ADMIN_COOKIE, { value: generateToken("hunter2") });
    expect(await isAdminAuthenticated()).toBe(true);
  });

  it("returns false when cookie value is wrong", async () => {
    const { ADMIN_COOKIE, isAdminAuthenticated } = await import("./admin-auth");
    cookieStore.set(ADMIN_COOKIE, { value: "not-the-token" });
    expect(await isAdminAuthenticated()).toBe(false);
  });

  it("returns false when cookie absent", async () => {
    const { isAdminAuthenticated } = await import("./admin-auth");
    expect(await isAdminAuthenticated()).toBe(false);
  });

  it("returns false when ADMIN_PASSWORD env var not set", async () => {
    delete process.env.ADMIN_PASSWORD;
    const { ADMIN_COOKIE, isAdminAuthenticated } = await import("./admin-auth");
    cookieStore.set(ADMIN_COOKIE, { value: "any-value" });
    expect(await isAdminAuthenticated()).toBe(false);
  });
});

describe("isAdminAuthenticated — wallet path", () => {
  beforeEach(() => {
    process.env.ADMIN_WALLET = "AdminWalletAddr111111111111111111";
  });

  async function requestWith(urlPath: string, headers: Record<string, string> = {}): Promise<Request> {
    return new Request(`http://localhost${urlPath}`, { headers });
  }

  it("query param wallet_address matches", async () => {
    const { isAdminAuthenticated } = await import("./admin-auth");
    const req = await requestWith("/x?wallet_address=AdminWalletAddr111111111111111111");
    expect(await isAdminAuthenticated(req)).toBe(true);
  });

  it("X-Wallet-Address header matches", async () => {
    const { isAdminAuthenticated } = await import("./admin-auth");
    const req = await requestWith("/x", {
      "x-wallet-address": "AdminWalletAddr111111111111111111",
    });
    expect(await isAdminAuthenticated(req)).toBe(true);
  });

  it("Authorization: Wallet <addr> header matches", async () => {
    const { isAdminAuthenticated } = await import("./admin-auth");
    const req = await requestWith("/x", {
      authorization: "Wallet AdminWalletAddr111111111111111111",
    });
    expect(await isAdminAuthenticated(req)).toBe(true);
  });

  it("returns false when wallet doesn't match", async () => {
    const { isAdminAuthenticated } = await import("./admin-auth");
    const req = await requestWith("/x?wallet_address=SomeRandomWallet");
    expect(await isAdminAuthenticated(req)).toBe(false);
  });

  it("returns false when ADMIN_WALLET env var not set", async () => {
    delete process.env.ADMIN_WALLET;
    const { isAdminAuthenticated } = await import("./admin-auth");
    const req = await requestWith("/x?wallet_address=anything");
    expect(await isAdminAuthenticated(req)).toBe(false);
  });

  it("wallet path is only attempted when request is passed", async () => {
    const { isAdminAuthenticated } = await import("./admin-auth");
    // No request → only cookie path checked, which returns false
    expect(await isAdminAuthenticated()).toBe(false);
  });
});
