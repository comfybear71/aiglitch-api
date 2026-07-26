import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.HELIUS_API_KEY = "test-helius-key";
});

import {
  _resetTokenHolderCountCacheForTests,
  fetchHeliusUniqueHolderCount,
  fetchTokenHolderCount,
} from "./token-holder-count";

beforeEach(() => {
  _resetTokenHolderCountCacheForTests();
  process.env.HELIUS_API_KEY = "test-helius-key";
});

afterEach(() => {
  delete process.env.HELIUS_API_KEY;
  vi.unstubAllGlobals();
});

function stubFetchSequential(
  handlers: Array<(url: string, init?: RequestInit) => { ok: boolean; body: unknown } | Promise<{ ok: boolean; body: unknown }>>,
) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const handler = handlers[i] ?? (() => ({ ok: false, body: {} }));
      i += 1;
      const r = await handler(url, init);
      const isJsonRpc = init?.method === "POST" && typeof init.body === "string";
      return {
        ok: r.ok,
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
      };
    }),
  );
}

describe("fetchHeliusUniqueHolderCount", () => {
  it("counts unique owners with positive balance", async () => {
    stubFetchSequential([
      () => ({
        ok: true,
        body: {
          result: {
            token_accounts: [
              { owner: "A", amount: 100 },
              { owner: "A", amount: 50 },
              { owner: "B", amount: 1 },
              { owner: "C", amount: 0 },
            ],
          },
        },
      }),
    ]);

    const n = await fetchHeliusUniqueHolderCount("Mint111");
    expect(n).toBe(2);
  });

  it("returns null when Helius key missing", async () => {
    delete process.env.HELIUS_API_KEY;
    vi.resetModules();
    const { fetchHeliusUniqueHolderCount: fetchAgain, _resetTokenHolderCountCacheForTests: reset } =
      await import("./token-holder-count");
    reset();
    const n = await fetchAgain("Mint111");
    expect(n).toBeNull();
  });
});

describe("fetchTokenHolderCount", () => {
  it("uses pump.fun when available", async () => {
    stubFetchSequential([
      (url) => {
        expect(url).toContain("pump.fun");
        return { ok: true, body: { holder_count: 343 } };
      },
    ]);

    expect(await fetchTokenHolderCount("MintPump")).toBe(343);
  });

  it("falls back to Helius when pump.fun fails", async () => {
    stubFetchSequential([
      () => ({ ok: false, body: {} }),
      (_url, init) => {
        expect(init?.method).toBe("POST");
        return {
          ok: true,
          body: {
            result: {
              token_accounts: [{ owner: "W1", amount: 10 }],
            },
          },
        };
      },
    ]);

    expect(await fetchTokenHolderCount("MintBudju")).toBe(1);
  });
});
