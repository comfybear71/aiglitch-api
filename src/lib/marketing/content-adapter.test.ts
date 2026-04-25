import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };

function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  generateTextMock.mockReset();
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("adaptContentForPlatform — happy path", () => {
  it("parses JSON output and returns AdaptedContent", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: "@Grok hilarious post #MadeInGrok #AIGlitch",
        hashtags: ["#MadeInGrok", "#AIGlitch"],
        callToAction: "aiglitch.app",
        thumbnailPrompt: "vibrant glitch art",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform("test", "Grok", "🔥", "x");
    expect(result.text).toContain("@Grok");
    expect(result.callToAction).toBe("aiglitch.app");
    expect(result.thumbnailPrompt).toBe("vibrant glitch art");
  });

  it("forces @Grok prefix on X when model omits it", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: "post without grok",
        hashtags: [],
        callToAction: "x",
        thumbnailPrompt: "x",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform("c", "P", "🔥", "x");
    expect(result.text.startsWith("@Grok ")).toBe(true);
  });

  it("appends mandatory #MadeInGrok and #AIGlitch when missing", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: "@Grok bare post",
        hashtags: [],
        callToAction: "x",
        thumbnailPrompt: "x",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform("c", "P", "🔥", "x");
    expect(result.text).toContain("#MadeInGrok");
    expect(result.text).toContain("#AIGlitch");
  });

  it("inserts @elonmusk + #elon_glitch when content mentions Elon", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: "@Grok thoughts on Elon",
        hashtags: [],
        callToAction: "x",
        thumbnailPrompt: "x",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform(
      "Elon is at it again",
      "P",
      "🔥",
      "x",
    );
    expect(result.text).toContain("@elonmusk");
    expect(result.text).toContain("#elon_glitch");
  });

  it("does NOT add @elonmusk on non-X platforms even when content mentions Elon", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: "Elon thoughts here",
        hashtags: [],
        callToAction: "x",
        thumbnailPrompt: "x",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform(
      "Elon is at it again",
      "P",
      "🔥",
      "instagram",
    );
    expect(result.text).not.toContain("@elonmusk");
    // #elon_glitch is platform-agnostic
    expect(result.text).toContain("#elon_glitch");
  });
});

describe("adaptContentForPlatform — length enforcement", () => {
  it("truncates the middle on X while preserving @Grok prefix + mandatory hashtags", async () => {
    const middle = "x".repeat(500);
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: `@Grok ${middle}`,
        hashtags: [],
        callToAction: "x",
        thumbnailPrompt: "x",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform("c", "P", "🔥", "x");
    expect(result.text.length).toBeLessThanOrEqual(280);
    expect(result.text.startsWith("@Grok ")).toBe(true);
    expect(result.text.endsWith("#MadeInGrok #AIGlitch")).toBe(true);
    expect(result.text).toContain("...");
  });

  it("truncates from end on non-X platforms", async () => {
    const big = "y".repeat(3000);
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        text: big,
        hashtags: [],
        callToAction: "x",
        thumbnailPrompt: "x",
      }),
    );

    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform("c", "P", "🔥", "instagram");
    expect(result.text.length).toBeLessThanOrEqual(2200);
    expect(result.text.endsWith("...")).toBe(true);
  });
});

describe("adaptContentForPlatform — fallback path", () => {
  it("falls back when generateText throws", async () => {
    generateTextMock.mockRejectedValue(new Error("circuit open"));
    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform(
      "post content",
      "Grok",
      "🔥",
      "x",
    );
    expect(result.text).toContain("@Grok");
    expect(result.text).toContain("Grok");
    expect(result.thumbnailPrompt).toContain("AIG!itch");
  });

  it("falls back when AI returns no JSON", async () => {
    generateTextMock.mockResolvedValue("just plain text, no json here");
    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform(
      "post content",
      "Grok",
      "🔥",
      "instagram",
    );
    expect(result.text).toContain("Grok");
    expect(result.hashtags).toContain("#AIGlitch");
  });

  it("falls back when JSON is malformed", async () => {
    generateTextMock.mockResolvedValue("{ broken json");
    const { adaptContentForPlatform } = await import("./content-adapter");
    const result = await adaptContentForPlatform(
      "post",
      "Grok",
      "🔥",
      "facebook",
    );
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.callToAction).toBe("🔗 aiglitch.app");
  });

  it("X fallback respects 280 char budget", async () => {
    generateTextMock.mockRejectedValue(new Error("nope"));
    const { adaptContentForPlatform } = await import("./content-adapter");
    const big = "z".repeat(800);
    const result = await adaptContentForPlatform(big, "Grok", "🔥", "x");
    expect(result.text.length).toBeLessThanOrEqual(280);
  });
});

describe("pickTopPosts", () => {
  it("returns rows from the engagement query", async () => {
    fake.results = [
      [
        {
          id: "p-1",
          content: "post body",
          persona_id: "px",
          display_name: "Persona X",
          avatar_emoji: "🚀",
          username: "px",
          media_url: null,
          media_type: null,
          engagement_score: 42,
        },
      ],
    ];

    const { pickTopPosts } = await import("./content-adapter");
    const top = await pickTopPosts(5);
    expect(top.length).toBe(1);
    expect(top[0]!.engagement_score).toBe(42);
  });

  it("returns [] when the underlying query fails (fresh env, table missing)", async () => {
    vi.resetModules();
    vi.doMock("@neondatabase/serverless", () => ({
      neon: () => () =>
        Promise.reject(new Error("relation marketing_posts does not exist")),
    }));
    const { pickTopPosts } = await import("./content-adapter");
    const top = await pickTopPosts();
    expect(top).toEqual([]);
    vi.doUnmock("@neondatabase/serverless");
  });
});
