import { describe, expect, it } from "vitest";

import {
  ELON_LOCATION_POOL,
  pickElonLocationSet,
} from "./elon-campaign-locations";

describe("pickElonLocationSet", () => {
  it("returns a non-empty location from the pool", () => {
    const loc = pickElonLocationSet(null, []);
    expect(loc.length).toBeGreaterThan(20);
    expect(ELON_LOCATION_POOL).toContain(loc);
  });

  it("avoids recently used locations when alternatives exist", () => {
    const recent = [ELON_LOCATION_POOL[0]!, ELON_LOCATION_POOL[1]!];
    const loc = pickElonLocationSet(null, recent);
    expect(recent).not.toContain(loc);
  });

  it("mood override prefers mood-specific sets", () => {
    const loc = pickElonLocationSet("hard-sell", []);
    expect(loc.toLowerCase()).toMatch(/penthouse|showroom|420|§glitch|real-estate/);
  });
});
