import { describe, expect, it } from "vitest";
import { getPromptPipelineCatalog } from "./prompt-pipelines";

describe("getPromptPipelineCatalog", () => {
  it("returns pipelines with preview-capable entries", () => {
    const { pipelines, breakingNewsSamples } = getPromptPipelineCatalog();
    expect(pipelines.length).toBeGreaterThanOrEqual(10);
    const chaos = pipelines.find((p) => p.id === "chaos-drops");
    expect(chaos?.previewSupported).toBe(true);
    expect(chaos?.previewParams?.[0]?.options?.length).toBeGreaterThan(1);
    expect(breakingNewsSamples.intro).toContain("GLITCH NEWS NETWORK");
    expect(breakingNewsSamples.presenter).toContain("Simulation President");
  });

  it("marks code-only pipelines as no preview", () => {
    const { pipelines } = getPromptPipelineCatalog();
    expect(pipelines.find((p) => p.id === "daily-topics")?.previewSupported).toBe(false);
  });
});
