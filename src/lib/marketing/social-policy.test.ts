import { describe, expect, it } from "vitest";
import {
  postsPerMarketingCycle,
  resolveImmediatePlatforms,
  type SocialAutoPolicy,
} from "./social-policy";

describe("postsPerMarketingCycle", () => {
  it("distributes daily cap across 6 marketing crons", () => {
    expect(postsPerMarketingCycle(0)).toBe(0);
    expect(postsPerMarketingCycle(3)).toBe(1);
    expect(postsPerMarketingCycle(6)).toBe(1);
    expect(postsPerMarketingCycle(7)).toBe(2);
  });
});

describe("resolveImmediatePlatforms", () => {
  const base: SocialAutoPolicy = {
    postsPerDay: 3,
    platforms: ["x", "telegram", "instagram", "facebook"],
    facebookAuto: true,
  };

  it("keeps facebook when facebookAuto is on", () => {
    expect(resolveImmediatePlatforms(base)).toEqual(base.platforms);
  });

  it("drops facebook when facebookAuto is off", () => {
    expect(
      resolveImmediatePlatforms({ ...base, facebookAuto: false }),
    ).toEqual(["x", "telegram", "instagram"]);
  });
});
