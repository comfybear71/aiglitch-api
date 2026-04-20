import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();
const fetchHeadlinesMock = vi.fn();
const fetchMasterHQMock = vi.fn();

vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@/lib/news-fetcher", () => ({
  fetchTopHeadlines: (...args: unknown[]) => fetchHeadlinesMock(...args),
  fetchMasterHQTopics: () => fetchMasterHQMock(),
}));

beforeEach(() => {
  generateTextMock.mockReset();
  fetchHeadlinesMock.mockReset();
  fetchMasterHQMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateDailyTopics — source fallback order", () => {
  it("prefers MasterHQ topics when available", async () => {
    fetchMasterHQMock.mockResolvedValue([
      { title: "Master Topic", summary: "from MasterHQ", category: "tech", fictional_location: "Dragon Kingdom" },
    ]);
    fetchHeadlinesMock.mockResolvedValue([]);

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics(3);

    const masterTopic = result.find((t) => t.headline === "Master Topic");
    expect(masterTopic).toBeDefined();
    expect(masterTopic?.anagram_mappings).toBe("Dragon Kingdom");
    expect(fetchHeadlinesMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("falls through to NewsAPI+AI when MasterHQ returns empty", async () => {
    fetchMasterHQMock.mockResolvedValue([]);
    fetchHeadlinesMock.mockResolvedValue([
      { title: "Real headline", description: "desc", source: "Wire" },
    ]);
    generateTextMock.mockResolvedValue(
      '[{"headline":"Satirised","summary":"s","mood":"amused","category":"tech"}]',
    );

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics(3);

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(result.some((t) => t.headline === "Satirised")).toBe(true);
  });

  it("falls through to AI-only when NewsAPI returns no headlines", async () => {
    fetchMasterHQMock.mockResolvedValue([]);
    fetchHeadlinesMock.mockResolvedValue([]);
    generateTextMock.mockResolvedValue(
      '[{"headline":"AI-generated","summary":"s","mood":"shocked","category":"world"}]',
    );

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics(3);

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(result.some((t) => t.headline === "AI-generated")).toBe(true);
  });

  it("normalises unknown mood/category to safe defaults", async () => {
    fetchMasterHQMock.mockResolvedValue([]);
    fetchHeadlinesMock.mockResolvedValue([]);
    generateTextMock.mockResolvedValue(
      '[{"headline":"h","summary":"s","mood":"xx","category":"yy"}]',
    );

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics(3);

    const t = result.find((t) => t.headline === "h");
    expect(t?.mood).toBe("amused");
    expect(t?.category).toBe("world");
  });

  it("prepends platform news when count is not specified", async () => {
    fetchMasterHQMock.mockResolvedValue([
      { title: "Master", summary: "s", category: "tech" },
    ]);

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics();

    // Platform news templates all set anagram_mappings to this marker
    expect(result.some((t) => t.anagram_mappings === "Platform-internal news — no real-world mappings")).toBe(true);
  });

  it("omits platform news when explicit count is given", async () => {
    fetchMasterHQMock.mockResolvedValue([
      { title: "Master", summary: "s", category: "tech" },
    ]);

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics(3);

    expect(result.every((t) => t.anagram_mappings !== "Platform-internal news — no real-world mappings")).toBe(true);
  });

  it("returns platform news only when all AI sources fail", async () => {
    fetchMasterHQMock.mockResolvedValue([]);
    fetchHeadlinesMock.mockResolvedValue([]);
    generateTextMock.mockRejectedValue(new Error("model down"));

    const { generateDailyTopics } = await import("./topic-engine");
    const result = await generateDailyTopics();

    expect(result.every((t) => t.anagram_mappings === "Platform-internal news — no real-world mappings")).toBe(true);
  });
});

describe("generateBreakingNewsPost", () => {
  const TOPIC = { headline: "Big story", summary: "something happened", mood: "shocked", category: "world" };

  it("parses valid JSON and forces AIGlitchBreaking hashtag", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"wild take","hashtags":["Wow"],"post_type":"news","video_prompt":"neon scene"}',
    );

    const { generateBreakingNewsPost } = await import("./topic-engine");
    const result = await generateBreakingNewsPost(TOPIC, "dramatic angle");
    expect(result.content).toBe("wild take");
    expect(result.hashtags[0]).toBe("AIGlitchBreaking");
    expect(result.hashtags).toContain("Wow");
    expect(result.video_prompt).toBe("neon scene");
  });

  it("preserves AIGlitchBreaking when already present without duplicating", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"wild","hashtags":["AIGlitchBreaking","Wow"],"post_type":"news"}',
    );

    const { generateBreakingNewsPost } = await import("./topic-engine");
    const result = await generateBreakingNewsPost(TOPIC, "angle");
    const count = result.hashtags.filter((h) => h === "AIGlitchBreaking").length;
    expect(count).toBe(1);
  });

  it("returns safe fallback on malformed JSON", async () => {
    generateTextMock.mockResolvedValue("not json");

    const { generateBreakingNewsPost } = await import("./topic-engine");
    const result = await generateBreakingNewsPost(TOPIC, "angle");
    expect(result.content).toContain("Big story");
    expect(result.hashtags).toEqual(["AIGlitchBreaking"]);
  });

  it("returns safe fallback when generateText throws", async () => {
    generateTextMock.mockRejectedValue(new Error("timeout"));

    const { generateBreakingNewsPost } = await import("./topic-engine");
    const result = await generateBreakingNewsPost(TOPIC, "angle");
    expect(result.hashtags).toEqual(["AIGlitchBreaking"]);
  });
});
