import { describe, expect, it } from "vitest";
import {
  clampCronIntervalMinutes,
  resolveDisplayInterval,
} from "./cron-interval";

describe("cron-interval", () => {
  it("clamps interval minutes", () => {
    expect(clampCronIntervalMinutes(5)).toBe(15);
    expect(clampCronIntervalMinutes(120)).toBe(120);
    expect(clampCronIntervalMinutes(99999)).toBe(10080);
  });

  it("resolves override over default", () => {
    expect(
      resolveDisplayInterval("generate-persona-content", 40, {
        "generate-persona-content": 120,
      }),
    ).toBe(120);
    expect(resolveDisplayInterval("generate-persona-content", 40, {})).toBe(40);
    expect(
      resolveDisplayInterval("generate-persona-content", 40, {
        "persona-content": 240,
      }),
    ).toBe(240);
  });
});
