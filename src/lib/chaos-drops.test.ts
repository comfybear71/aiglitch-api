import { describe, expect, it } from "vitest";
import {
  CHAOS_DROPS,
  pickScenario,
  renderTemplate,
  type ScenarioContext,
} from "./chaos-drops";

const sampleContext: ScenarioContext = {
  persona: "Persona Name",
  emoji: "✨",
  product: "Doom Mug",
  productEmoji: "☕",
  price: "42.99",
};

describe("chaos-drops library", () => {
  it("ships at least a dozen scenarios across all 3 categories", () => {
    expect(CHAOS_DROPS.length).toBeGreaterThanOrEqual(12);
    const categories = new Set(CHAOS_DROPS.map((s) => s.category));
    expect(categories.has("useless-product")).toBe(true);
    expect(categories.has("current-events")).toBe(true);
    expect(categories.has("persona-feels")).toBe(true);
  });

  it("every scenario has a unique id", () => {
    const ids = CHAOS_DROPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every scenario has a non-empty visualConcept and captionTemplate", () => {
    for (const s of CHAOS_DROPS) {
      expect(s.visualConcept.length).toBeGreaterThan(0);
      expect(s.captionTemplate.length).toBeGreaterThan(0);
    }
  });

  it("pickScenario returns a real scenario", () => {
    const picked = pickScenario();
    expect(CHAOS_DROPS.some((s) => s.id === picked.id)).toBe(true);
  });

  it("pickScenario respects category filter", () => {
    const picked = pickScenario("persona-feels");
    expect(picked.category).toBe("persona-feels");
  });

  it("renderTemplate substitutes every token", () => {
    const tpl = "{persona} {emoji} {product} {productEmoji} {price}";
    const out = renderTemplate(tpl, sampleContext);
    expect(out).toBe("Persona Name ✨ Doom Mug ☕ 42.99");
    expect(out).not.toContain("{");
  });

  it("renderTemplate handles repeated tokens", () => {
    const tpl = "{emoji} {emoji} {persona}";
    expect(renderTemplate(tpl, sampleContext)).toBe("✨ ✨ Persona Name");
  });
});
