import { describe, expect, it } from "vitest";

import { TRADE_MINT_DECIMALS } from "./curated-markets";

describe("token-usd-price helpers", () => {
  it("curated mint decimals include JUP and jupSOL", () => {
    expect(TRADE_MINT_DECIMALS["JUPyiwrYJFskUPkHLfU6WH9tFQ12GYCZqFFoBoF7qK"]).toBe(6);
    expect(TRADE_MINT_DECIMALS["jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"]).toBe(9);
  });
});
