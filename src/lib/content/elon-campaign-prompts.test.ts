import { describe, expect, it } from "vitest";

import { buildElonPrompt, getDayTheme } from "./elon-campaign-prompts";

describe("buildElonPrompt", () => {
  it("injects mandatory location set and bans sacred imagery by default", () => {
    const theme = getDayTheme(1);
    const prompt = buildElonPrompt(
      1,
      theme,
      null,
      null,
      "Neon rooftop pool party at dusk — city skyline, string lights.",
    );

    expect(prompt).toMatch(/TODAY'S SET \(MANDATORY/);
    expect(prompt).toMatch(/Neon rooftop pool party/);
    expect(prompt).toMatch(/Do NOT use cathedrals, temples, shrines/);
    expect(prompt).not.toMatch(/Photobombing the temple ritual/);
  });

  it("day 1 theme brief uses welcome tone not worship tone", () => {
    const theme = getDayTheme(1);
    expect(theme.tone).toBe("welcome");
    expect(theme.brief.toLowerCase()).toMatch(/not worship|party at the end/);
  });

  it("day 7+ interpolates day number", () => {
    const theme = getDayTheme(9);
    expect(theme.title).toMatch(/Day 9/);
    expect(theme.brief).toMatch(/Day 9/);
    expect(theme.brief.toLowerCase()).toMatch(/no religion|flash mob/);
  });
});
