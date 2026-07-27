import { describe, expect, it } from "vitest";

import {
  TRADE_ALLOWED_MINTS,
  TRADE_CURATED_JUPITER_TOKENS,
  tradeMintFromSymbol,
} from "./curated-markets";

describe("curated-markets", () => {
  it("includes curated majors and LSTs", () => {
    const symbols = TRADE_CURATED_JUPITER_TOKENS.map((t) => t.symbol);
    expect(symbols).toContain("JUP");
    expect(symbols).toContain("jupSOL");
    expect(TRADE_CURATED_JUPITER_TOKENS.filter((t) => t.yieldLst)).toHaveLength(3);
    expect(symbols).toContain("PSOL");
    expect(symbols).toContain("WBTC");
  });

  it("resolves mints for swap symbols", () => {
    expect(tradeMintFromSymbol("jupSOL")).toMatch(/^jupSo/);
    expect(tradeMintFromSymbol("UNKNOWN")).toBeNull();
    expect(TRADE_ALLOWED_MINTS.size).toBeGreaterThanOrEqual(13);
  });
});
