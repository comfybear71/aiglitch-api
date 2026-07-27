import { describe, expect, it } from "vitest";

import { TRADE_MINT_DECIMALS } from "./curated-markets";

describe("token-usd-price helpers", () => {
  it("curated mint decimals include JUP and jupSOL", () => {
    expect(TRADE_MINT_DECIMALS["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]).toBe(6);
    expect(TRADE_MINT_DECIMALS["jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"]).toBe(9);
  });

  it("RAY mint is Raydium mainnet (not corrupted suffix)", () => {
    expect(TRADE_MINT_DECIMALS["4k3Dyjzvzp8eMZWUXbBCjJ7zCkQTJGFaW5dCxM8DrU9"]).toBe(6);
  });
});
