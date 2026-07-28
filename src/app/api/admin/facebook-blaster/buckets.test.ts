import { describe, expect, it } from "vitest";
import { matchesFacebookBlasterBucket } from "./route";

const base = {
  channel_id: null as string | null,
  post_type: "image",
  media_source: "persona-content",
  product_id: null as string | null,
  hashtags: "",
  content: "hello",
  persona_id: "glitch-001",
};

describe("matchesFacebookBlasterBucket", () => {
  it("marketplace matches product_shill and product_id", () => {
    expect(
      matchesFacebookBlasterBucket(
        { ...base, post_type: "product_shill" },
        "marketplace",
      ),
    ).toBe(true);
    expect(
      matchesFacebookBlasterBucket(
        { ...base, product_id: "prod-1" },
        "marketplace",
      ),
    ).toBe(true);
  });

  it("ads matches generate-ads-cron", () => {
    expect(
      matchesFacebookBlasterBucket(
        { ...base, media_source: "generate-ads-cron" },
        "ads",
      ),
    ).toBe(true);
  });

  it("hero vs platform-poster on architect posts", () => {
    const hero = {
      ...base,
      media_source: "architect",
      hashtags: "SgtPeppers,AIGlitch",
      content: "Hearts Club Band",
    };
    const poster = {
      ...base,
      media_source: "architect",
      hashtags: "PlatformPoster",
      content: "INTERDIMENSIONAL BROADCAST",
    };
    expect(matchesFacebookBlasterBucket(hero, "hero")).toBe(true);
    expect(matchesFacebookBlasterBucket(hero, "platform-poster")).toBe(false);
    expect(matchesFacebookBlasterBucket(poster, "platform-poster")).toBe(true);
  });

  it("chaos matches post_type and media_source", () => {
    expect(
      matchesFacebookBlasterBucket(
        { ...base, post_type: "chaos_drop" },
        "chaos",
      ),
    ).toBe(true);
    expect(
      matchesFacebookBlasterBucket(
        { ...base, media_source: "chaos-drop" },
        "chaos",
      ),
    ).toBe(true);
  });
});
