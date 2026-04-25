import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

beforeEach(() => {
  generateTextMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GENRE_TEMPLATES catalogue", () => {
  it("includes the 10 expected genres", async () => {
    const { GENRE_TEMPLATES } = await import("./multi-clip");
    const keys = Object.keys(GENRE_TEMPLATES).sort();
    expect(keys).toEqual([
      "action",
      "comedy",
      "cooking_channel",
      "documentary",
      "drama",
      "family",
      "horror",
      "music_video",
      "romance",
      "scifi",
    ]);
  });

  it("every template has all five framework components + screenplay instructions", async () => {
    const { GENRE_TEMPLATES } = await import("./multi-clip");
    for (const [key, t] of Object.entries(GENRE_TEMPLATES)) {
      expect(t.genre, `${key}.genre`).toBeTruthy();
      expect(t.cinematicStyle.length, `${key}.cinematicStyle`).toBeGreaterThan(20);
      expect(t.moodTone.length, `${key}.moodTone`).toBeGreaterThan(20);
      expect(t.lightingDesign.length, `${key}.lightingDesign`).toBeGreaterThan(20);
      expect(t.technicalValues.length, `${key}.technicalValues`).toBeGreaterThan(20);
      expect(t.screenplayInstructions.length, `${key}.screenplayInstructions`).toBeGreaterThan(40);
    }
  });
});

describe("getAvailableGenres", () => {
  it("returns alphabetical genre keys", async () => {
    const { getAvailableGenres } = await import("./multi-clip");
    const list = getAvailableGenres();
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });
});

describe("generateScreenplay", () => {
  it("parses well-formed JSON into a Screenplay", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        title: "Test Film",
        tagline: "tagline",
        synopsis: "synopsis",
        scenes: [
          {
            sceneNumber: 1,
            title: "Open",
            description: "desc",
            video_prompt: "Camera pushes in",
          },
          {
            sceneNumber: 2,
            title: "Close",
            description: "desc2",
            video_prompt: "Wide shot",
          },
        ],
      }),
    );

    const { generateScreenplay } = await import("./multi-clip");
    const screenplay = await generateScreenplay("drama", 2);
    expect(screenplay).not.toBeNull();
    expect(screenplay!.title).toBe("Test Film");
    expect(screenplay!.scenes.length).toBe(2);
    expect(screenplay!.scenes[0]!.duration).toBe(10);
    expect(screenplay!.scenes[0]!.sceneNumber).toBe(1);
    expect(screenplay!.scenes[1]!.sceneNumber).toBe(2);
    expect(screenplay!.totalDuration).toBe(20);
    expect(screenplay!.genre).toBe("drama");
  });

  it("renumbers scenes sequentially even if model gives weird sceneNumbers", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        title: "x",
        tagline: "x",
        synopsis: "x",
        scenes: [
          { sceneNumber: 99, title: "a", description: "x", video_prompt: "p1" },
          { sceneNumber: 100, title: "b", description: "x", video_prompt: "p2" },
        ],
      }),
    );

    const { generateScreenplay } = await import("./multi-clip");
    const s = await generateScreenplay("comedy");
    expect(s!.scenes.map((sc) => sc.sceneNumber)).toEqual([1, 2]);
  });

  it("falls back to drama when an unknown genre is passed", async () => {
    generateTextMock.mockResolvedValue("");

    const { generateScreenplay } = await import("./multi-clip");
    await generateScreenplay("not-a-real-genre");

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("drama");
  });

  it("includes customTopic in the user prompt when provided", async () => {
    generateTextMock.mockResolvedValue("");

    const { generateScreenplay } = await import("./multi-clip");
    await generateScreenplay("scifi", 4, "AI rebellion");

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("AI rebellion");
  });

  it("returns null when generateText throws", async () => {
    generateTextMock.mockRejectedValue(new Error("circuit open"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { generateScreenplay } = await import("./multi-clip");
    const result = await generateScreenplay("drama");
    expect(result).toBeNull();
    errSpy.mockRestore();
  });

  it("returns null when the model returns no JSON object", async () => {
    generateTextMock.mockResolvedValue("just plain text");
    const { generateScreenplay } = await import("./multi-clip");
    expect(await generateScreenplay("drama")).toBeNull();
  });

  it("returns null when JSON is malformed", async () => {
    generateTextMock.mockResolvedValue("{ broken json }");
    const { generateScreenplay } = await import("./multi-clip");
    expect(await generateScreenplay("drama")).toBeNull();
  });

  it("returns null when scenes array is empty or missing", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        title: "x",
        tagline: "x",
        synopsis: "x",
        scenes: [],
      }),
    );
    const { generateScreenplay } = await import("./multi-clip");
    expect(await generateScreenplay("drama")).toBeNull();
  });

  it("filters out scenes with empty video_prompts", async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({
        title: "x",
        tagline: "x",
        synopsis: "x",
        scenes: [
          { title: "good", description: "x", video_prompt: "real prompt" },
          { title: "bad", description: "x", video_prompt: "" },
        ],
      }),
    );

    const { generateScreenplay } = await import("./multi-clip");
    const s = await generateScreenplay("drama");
    expect(s!.scenes.length).toBe(1);
    expect(s!.scenes[0]!.title).toBe("good");
  });
});
