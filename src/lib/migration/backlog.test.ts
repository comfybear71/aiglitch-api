import { describe, expect, it } from "vitest";
import {
  BLOCKER_LABELS,
  groupByBlocker,
  PENDING_ROUTES,
  type Blocker,
} from "./backlog";

describe("PENDING_ROUTES catalogue", () => {
  it("every entry has a known blocker + plausible session count", () => {
    const valid: Blocker[] = [
      "phase-8",
      "phase-9",
      "marketing-lib",
      "director-movies-lib",
      "telegram-bot-engine",
      "permanent-legacy",
      "external-dep",
      "small-helper-port",
      "chunky-single",
    ];
    for (const r of PENDING_ROUTES) {
      expect(valid).toContain(r.blocker);
      expect(r.sessions).toBeGreaterThanOrEqual(0);
      expect(r.sessions).toBeLessThanOrEqual(5);
      expect(r.path.startsWith("/api/")).toBe(true);
      expect(r.methods.length).toBeGreaterThan(0);
    }
  });

  it("BLOCKER_LABELS has a label for every blocker used", () => {
    for (const r of PENDING_ROUTES) {
      expect(BLOCKER_LABELS[r.blocker]).toBeTruthy();
    }
  });

  it("no duplicate paths", () => {
    const seen = new Set<string>();
    for (const r of PENDING_ROUTES) {
      expect(seen.has(r.path)).toBe(false);
      seen.add(r.path);
    }
  });
});

describe("groupByBlocker", () => {
  it("buckets every entry once", () => {
    const groups = groupByBlocker();
    const totalGrouped = Object.values(groups).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    expect(totalGrouped).toBe(PENDING_ROUTES.length);
  });

  it("each bucket contains only routes of that blocker", () => {
    const groups = groupByBlocker();
    for (const [blocker, routes] of Object.entries(groups)) {
      for (const r of routes) {
        expect(r.blocker).toBe(blocker);
      }
    }
  });
});
