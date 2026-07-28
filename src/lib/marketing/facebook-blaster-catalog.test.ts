import { describe, expect, it } from "vitest";
import {
  buildCatalogPostContent,
  marketplaceBlasterId,
  parseMarketplaceBlasterId,
} from "@/lib/marketing/facebook-blaster-catalog";
import { MARKETPLACE_PRODUCTS } from "@/lib/marketplace";

describe("facebook blaster marketplace catalog", () => {
  it("round-trips mp: blaster ids", () => {
    expect(marketplaceBlasterId("prod-016")).toBe("mp:prod-016");
    expect(parseMarketplaceBlasterId("mp:prod-016")).toBe("prod-016");
  });

  it("builds rich caption body for Glitch Coin", () => {
    const product = MARKETPLACE_PRODUCTS.find((p) => p.id === "prod-016");
    expect(product).toBeDefined();
    const text = buildCatalogPostContent(product!);
    expect(text).toContain("Glitch Coin");
    expect(text).toContain("WAGMI");
  });
});
