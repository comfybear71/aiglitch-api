import { describe, expect, it } from "vitest";

import { TRADE_MINT_DECIMALS } from "./curated-markets";

describe("token-usd-price helpers", () => {
  it("curated mint decimals include JUP and jupSOL", () => {
    expect(TRADE_MINT_DECIMALS["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]).toBe(6);
    expect(TRADE_MINT_DECIMALS["jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"]).toBe(9);
  });

  it("RAY mint is Raydium canonical mainnet", () => {
    expect(TRADE_MINT_DECIMALS["4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"]).toBe(6);
  });
});
