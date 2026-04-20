import { describe, expect, it } from "vitest";
import { getRarity, parseCoinPrice, rarityColor } from "./nft-mint";

describe("getRarity", () => {
  it.each([
    [0, "common"],
    [24, "common"],
    [25, "uncommon"],
    [49, "uncommon"],
    [50, "rare"],
    [99, "rare"],
    [100, "epic"],
    [199, "epic"],
    [200, "legendary"],
    [9999, "legendary"],
  ])("price %i → %s", (price, expected) => {
    expect(getRarity(price)).toBe(expected);
  });
});

describe("rarityColor", () => {
  it("returns the mapped hex per rarity", () => {
    expect(rarityColor("legendary")).toBe("#FFD700");
    expect(rarityColor("epic")).toBe("#A855F7");
    expect(rarityColor("rare")).toBe("#3B82F6");
    expect(rarityColor("uncommon")).toBe("#22C55E");
    expect(rarityColor("common")).toBe("#9CA3AF");
  });

  it("falls back to common for unknown rarity", () => {
    expect(rarityColor("nonexistent")).toBe("#9CA3AF");
  });
});

describe("parseCoinPrice", () => {
  it("strips § and parses", () => {
    expect(parseCoinPrice("§69")).toBe(69);
  });

  it("accepts a plain number string", () => {
    expect(parseCoinPrice("42")).toBe(42);
  });

  it("ceils fractional prices", () => {
    expect(parseCoinPrice("§24.1")).toBe(25);
    expect(parseCoinPrice("§49.9")).toBe(50);
  });
});
