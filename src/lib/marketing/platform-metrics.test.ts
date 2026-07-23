import { describe, expect, it } from "vitest";
import { enrichPlatformBreakdown } from "./platform-metrics";

describe("enrichPlatformBreakdown", () => {
  it("uses Views label for YouTube primary metric", () => {
    const row = enrichPlatformBreakdown({
      platform: "youtube",
      posted: 10,
      queued: 0,
      failed: 2,
      impressions: 0,
      likes: 5,
      views: 1200,
      shares: 0,
      comments: 1,
      lastPostedAt: null,
      lastMetricsSync: "2026-07-22T00:00:00Z",
      followers: null,
    });
    expect(row.primaryLabel).toBe("Views");
    expect(row.primaryValue).toBe(1200);
    expect(row.successRate).toBeCloseTo(83.3, 1);
  });

  it("shows subscribers for Telegram from follower count", () => {
    const row = enrichPlatformBreakdown({
      platform: "telegram",
      posted: 500,
      queued: 0,
      failed: 10,
      impressions: 0,
      likes: 0,
      views: 0,
      shares: 0,
      comments: 0,
      lastPostedAt: null,
      lastMetricsSync: null,
      followers: 4200,
    });
    expect(row.primaryLabel).toBe("Subscribers");
    expect(row.primaryValue).toBe(4200);
    expect(row.postMetricsSupported).toBe(false);
  });

  it("shows Followers secondary for Facebook", () => {
    const row = enrichPlatformBreakdown({
      platform: "facebook",
      posted: 100,
      queued: 0,
      failed: 20,
      impressions: 0,
      likes: 786,
      views: 0,
      shares: 436,
      comments: 0,
      lastPostedAt: null,
      lastMetricsSync: "2026-07-22T00:00:00Z",
      followers: 880,
    });
    const followers = row.secondaryMetrics.find((m) => m.label === "Followers");
    expect(followers?.value).toBe(880);
  });
});
