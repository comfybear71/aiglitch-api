import { describe, expect, it } from "vitest";
import {
  SPONSOR_PACKAGES,
  AD_STYLES,
  SPONSOR_STATUSES,
  SPONSORED_AD_STATUSES,
  INDUSTRIES,
  buildSponsoredAdPrompt,
} from "./sponsor-packages";

describe("SPONSOR_PACKAGES", () => {
  it("exposes the two primary MasterHQ tiers + four legacy tiers", () => {
    const keys = Object.keys(SPONSOR_PACKAGES).sort();
    expect(keys).toEqual(["basic", "chaos", "glitch", "premium", "standard", "ultra"].sort());
  });

  it("glitch tier pricing matches $50 / 500 GLITCH", () => {
    expect(SPONSOR_PACKAGES.glitch.glitch_cost).toBe(500);
    expect(SPONSOR_PACKAGES.glitch.cash_equivalent).toBe(50);
  });

  it("ultra tier is the only pinned + follow-up tier", () => {
    const pinned = Object.values(SPONSOR_PACKAGES).filter((p) => p.pinned);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].name).toBe("Ultra");
    expect(pinned[0].follow_ups).toBe(3);
  });
});

describe("enum exports", () => {
  it("AD_STYLES covers the five recognised ad styles", () => {
    expect(AD_STYLES).toContain("product_showcase");
    expect(AD_STYLES).toContain("unboxing");
  });

  it("SPONSOR_STATUSES covers the full funnel", () => {
    expect(SPONSOR_STATUSES).toContain("inquiry");
    expect(SPONSOR_STATUSES).toContain("active");
    expect(SPONSOR_STATUSES).toContain("churned");
  });

  it("SPONSORED_AD_STATUSES covers the creative pipeline", () => {
    expect(SPONSOR_STATUSES.length).toBeGreaterThan(0);
    expect(SPONSORED_AD_STATUSES).toContain("pending_review");
    expect(SPONSORED_AD_STATUSES).toContain("published");
  });

  it("INDUSTRIES list has Crypto/Web3 and Other", () => {
    expect(INDUSTRIES).toContain("Crypto / Web3");
    expect(INDUSTRIES).toContain("Other");
  });
});

describe("buildSponsoredAdPrompt", () => {
  const base = {
    product_name: "Widget",
    product_description: "A sleek widget",
    ad_style: "product_showcase",
    duration: 10,
  };

  it("includes the product metadata and base rules", () => {
    const prompt = buildSponsoredAdPrompt(base);
    expect(prompt).toContain("Widget");
    expect(prompt).toContain("A sleek widget");
    expect(prompt).toContain("product_showcase");
    expect(prompt).toContain("Duration: 10 seconds");
    expect(prompt).toContain("#ad and #sponsored");
  });

  it("appends logo rule 9 when logo_url is provided", () => {
    const prompt = buildSponsoredAdPrompt({ ...base, logo_url: "https://x/logo.png" });
    expect(prompt).toContain("Logo URL: https://x/logo.png");
    expect(prompt).toContain("9. Feature the sponsor's logo");
  });

  it("accepts product_images as strings or ProductImage objects", () => {
    const promptA = buildSponsoredAdPrompt({ ...base, product_images: ["https://x/a.png"] });
    const promptB = buildSponsoredAdPrompt({
      ...base,
      product_images: [{ url: "https://x/b.png", type: "image" }],
    });
    expect(promptA).toContain("https://x/a.png");
    expect(promptB).toContain("https://x/b.png");
    expect(promptA).toContain("10. Reference the product images");
  });

  it("asks for JSON with video_prompt + caption + x_caption", () => {
    const prompt = buildSponsoredAdPrompt(base);
    expect(prompt).toContain('"video_prompt"');
    expect(prompt).toContain('"caption"');
    expect(prompt).toContain('"x_caption"');
  });
});
