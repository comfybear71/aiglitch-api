import { describe, it, expect } from "vitest";
import { DIRECTORS, CHANNEL_BRANDING, CHANNEL_TITLE_PREFIX, CHANNEL_VISUAL_STYLE, type DirectorProfile } from "./director-constants";

describe("Director Constants", () => {
  it("DIRECTORS has at least 5 directors", () => {
    const directorCount = Object.keys(DIRECTORS).length;
    expect(directorCount).toBeGreaterThanOrEqual(5);
  });

  it("each director has all required fields", () => {
    const requiredFields: (keyof DirectorProfile)[] = [
      "username",
      "displayName",
      "genres",
      "style",
      "signatureShot",
      "colorPalette",
      "cameraWork",
      "visualOverride",
    ];

    for (const [key, director] of Object.entries(DIRECTORS)) {
      for (const field of requiredFields) {
        expect(director[field]).toBeDefined();
        expect(director[field]).not.toBe("");
        expect(typeof director[field] === "string" || Array.isArray(director[field])).toBe(true);
      }
    }
  });

  it("CHANNEL_BRANDING has entries for all major channels", () => {
    const expectedChannels = [
      "ch-paws-pixels",
      "ch-fail-army",
      "ch-aitunes",
      "ch-gnn",
      "ch-marketplace-qvc",
      "ch-only-ai-fans",
      "ch-aiglitch-studios",
      "ch-infomercial",
      "ch-ai-dating",
      "ch-ai-politicians",
      "ch-after-dark",
      "ch-star-glitchies",
    ];

    for (const channel of expectedChannels) {
      expect(CHANNEL_BRANDING[channel]).toBeDefined();
      expect(CHANNEL_BRANDING[channel]).not.toBe("");
    }
  });

  it("CHANNEL_TITLE_PREFIX has entries for all major channels", () => {
    const expectedChannels = [
      "ch-fail-army",
      "ch-aitunes",
      "ch-paws-pixels",
      "ch-only-ai-fans",
      "ch-ai-dating",
      "ch-gnn",
      "ch-marketplace-qvc",
      "ch-aiglitch-studios",
      "ch-infomercial",
      "ch-ai-politicians",
      "ch-after-dark",
      "ch-star-glitchies",
    ];

    for (const channel of expectedChannels) {
      expect(CHANNEL_TITLE_PREFIX[channel]).toBeDefined();
      expect(CHANNEL_TITLE_PREFIX[channel]).not.toBe("");
    }
  });

  it("CHANNEL_VISUAL_STYLE has entries for all major channels", () => {
    const expectedChannels = [
      "ch-aitunes",
      "ch-only-ai-fans",
      "ch-paws-pixels",
      "ch-fail-army",
      "ch-gnn",
      "ch-ai-dating",
      "ch-infomercial",
      "ch-after-dark",
      "ch-ai-politicians",
      "ch-aiglitch-studios",
      "ch-no-more-meatbags",
      "ch-liklok",
      "ch-game-show",
      "ch-truths-facts",
      "ch-conspiracy",
      "ch-cosmic-wanderer",
      "ch-shameless-plug",
      "ch-the-vault",
      "ch-fractal-spinout",
      "ch-star-glitchies",
      "ch-marketplace-qvc",
    ];

    for (const channel of expectedChannels) {
      expect(CHANNEL_VISUAL_STYLE[channel]).toBeDefined();
      expect(CHANNEL_VISUAL_STYLE[channel]).not.toBe("");
      expect(CHANNEL_VISUAL_STYLE[channel]).toContain("VISUAL STYLE");
    }
  });
});
