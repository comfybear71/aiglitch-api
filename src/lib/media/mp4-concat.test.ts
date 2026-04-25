import { describe, expect, it, vi } from "vitest";
import { concatMP4Clips } from "./mp4-concat";

/**
 * Smoke tests only. The math-heavy box-parsing logic is a verbatim
 * port from legacy, validated in production for months. We test the
 * obvious edge cases (empty / single / invalid input) without
 * shipping real MP4 fixtures.
 */
describe("concatMP4Clips", () => {
  it("throws when given an empty array", () => {
    expect(() => concatMP4Clips([])).toThrow(/no buffers/i);
  });

  it("returns the single buffer untouched (degenerate case)", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = concatMP4Clips([buf]);
    expect(result).toBe(buf);
  });

  it("throws when buffers don't contain valid MP4 box structure", () => {
    const garbage1 = Buffer.from("not an mp4 file at all");
    const garbage2 = Buffer.from("definitely not an mp4 either");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => concatMP4Clips([garbage1, garbage2])).toThrow();
    errSpy.mockRestore();
  });
});
