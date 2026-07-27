import { describe, expect, it, vi, afterEach } from "vitest";

import { resolveTradeTokenMetaForMint } from "./token-metadata";

describe("token-metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns aiglitch static icon for GLITCH mint", async () => {
    const meta = await resolveTradeTokenMetaForMint(
      "5hfHCmaL6e9bvruy35RQyghMXseTE2mXJ7ukqKAcS8fT",
    );
    expect(meta?.symbol).toBe("GLITCH");
    expect(meta?.source).toBe("aiglitch");
    expect(meta?.iconUrl).toBe("/tokens/glitch.svg");
    expect(meta?.iconEmoji).toBe("§");
  });

  it("parses Jupiter search response for curated mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
              name: "Jupiter",
              symbol: "JUP",
              icon: "https://static.jup.ag/jup/icon.png",
            },
          ],
        }),
      })),
    );

    const meta = await resolveTradeTokenMetaForMint(
      "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    );
    expect(meta?.source).toBe("jupiter");
    expect(meta?.iconUrl).toContain("static.jup.ag");
    expect(meta?.name).toBe("Jupiter");
  });
});
