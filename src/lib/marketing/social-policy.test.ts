import { describe, expect, it } from "vitest";
import { postsPerMarketingCycle } from "./social-policy";

describe("postsPerMarketingCycle", () => {
  it("distributes daily cap across 6 marketing crons", () => {
    expect(postsPerMarketingCycle(0)).toBe(0);
    expect(postsPerMarketingCycle(3)).toBe(1);
    expect(postsPerMarketingCycle(6)).toBe(1);
    expect(postsPerMarketingCycle(7)).toBe(2);
  });
});
