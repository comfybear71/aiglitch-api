import { describe, expect, it } from "vitest";
import { getRouteHint, ROUTE_HINTS } from "./route-hints";

describe("ROUTE_HINTS shape", () => {
  it("every entry has at least one method", () => {
    for (const [path, entry] of Object.entries(ROUTE_HINTS)) {
      expect(
        Object.keys(entry.methods).length,
        `${path} has no methods`,
      ).toBeGreaterThan(0);
    }
  });

  it("every method has a non-empty description", () => {
    for (const [path, entry] of Object.entries(ROUTE_HINTS)) {
      for (const [m, hint] of Object.entries(entry.methods)) {
        expect(
          hint.description,
          `${m} ${path} missing description`,
        ).toBeTruthy();
        expect(hint.description.length).toBeGreaterThan(5);
      }
    }
  });

  it("GET hints never include a body", () => {
    for (const [path, entry] of Object.entries(ROUTE_HINTS)) {
      if (entry.methods.GET) {
        expect(entry.methods.GET.body, `GET ${path} should not have body`).toBeUndefined();
      }
    }
  });

  it("path_params keys are bracket segments", () => {
    for (const [path, entry] of Object.entries(ROUTE_HINTS)) {
      for (const m of Object.values(entry.methods)) {
        if (!m.path_params) continue;
        for (const key of Object.keys(m.path_params)) {
          expect(
            key.match(/^\[\w+\]$/),
            `path_param key "${key}" on ${path} must be "[name]"`,
          ).toBeTruthy();
        }
      }
    }
  });
});

describe("getRouteHint", () => {
  it("returns the entry for a known path", () => {
    const hit = getRouteHint("/api/health");
    expect(hit).not.toBeNull();
    expect(hit!.methods.GET?.description).toContain("Liveness");
  });

  it("returns null for an unknown path", () => {
    expect(getRouteHint("/api/does-not-exist-xyz")).toBeNull();
  });

  it("includes the key migration console endpoints", () => {
    for (const p of [
      "/api/admin/migration/status",
      "/api/admin/migration/test",
      "/api/admin/migration/log",
      "/api/admin/migration/metrics",
      "/api/admin/migration/route-hint",
    ]) {
      expect(getRouteHint(p), `missing hint for ${p}`).not.toBeNull();
    }
  });
});
