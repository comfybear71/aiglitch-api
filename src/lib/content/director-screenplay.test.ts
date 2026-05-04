import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorProfile } from "./director-constants";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

const generateWithGrokMock = vi.fn();
const isXAIConfiguredMock = vi.fn();
vi.mock("@/lib/ai/xai-extras", () => ({
  generateWithGrok: (...a: unknown[]) => generateWithGrokMock(...a),
  isXAIConfigured: () => isXAIConfiguredMock(),
}));

vi.mock("@/lib/prompt-overrides", () => ({
  getPrompt: (_cat: string, _key: string, def: string) => Promise.resolve(def),
}));

vi.mock("@/lib/ad-campaigns", () => ({
  getActiveCampaigns: () => Promise.resolve([]),
  rollForPlacements: () => [],
  buildVisualPlacementPrompt: () => "",
}));

const TEST_DIRECTOR: DirectorProfile = {
  username: "test_director",
  displayName: "Test Director",
  genres: ["drama", "action"],
  style: "test style",
  signatureShot: "test shot",
  colorPalette: "test palette",
  cameraWork: "test camera",
  visualOverride: "test override",
};

const VALID_SCREENPLAY_JSON = JSON.stringify({
  title: "Test Movie",
  tagline: "test tagline",
  synopsis: "test synopsis",
  character_bible: "test bible",
  scenes: [
    {
      sceneNumber: 1,
      title: "Scene 1",
      description: "scene desc 1",
      video_prompt: "scene prompt 1",
      last_frame: "frame 1",
    },
    {
      sceneNumber: 2,
      title: "Scene 2",
      description: "scene desc 2",
      video_prompt: "scene prompt 2",
      last_frame: "frame 2",
    },
  ],
});

beforeEach(() => {
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  generateTextMock.mockReset();
  generateWithGrokMock.mockReset();
  isXAIConfiguredMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("generateDirectorScreenplay", () => {
  it("previewOnly returns the assembled prompt without calling AI", async () => {
    isXAIConfiguredMock.mockReturnValue(false);
    fake.results = [
      [{ id: "d-1" }], // director lookup
      [], // castActors
    ];

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay(
      "drama",
      TEST_DIRECTOR,
      undefined,
      undefined,
      true,
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("Test Director");
    expect(result).toContain("drama");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(generateWithGrokMock).not.toHaveBeenCalled();
  });

  it("uses Grok-reasoning when xAI is configured and dice land < 0.5", async () => {
    isXAIConfiguredMock.mockReturnValue(true);
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    fake.results = [
      [{ id: "d-1" }],
      [{ id: "a-1", username: "alpha", display_name: "Alpha" }],
    ];
    generateWithGrokMock.mockResolvedValue(VALID_SCREENPLAY_JSON);

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay("drama", TEST_DIRECTOR);

    expect(result).not.toBeNull();
    expect(typeof result).not.toBe("string");
    if (result && typeof result !== "string") {
      expect(result.title).toBe("Test Movie");
      expect(result.screenplayProvider).toBe("grok");
    }
    expect(generateWithGrokMock).toHaveBeenCalledOnce();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("falls back to generateText when Grok-reasoning returns unparseable", async () => {
    isXAIConfiguredMock.mockReturnValue(true);
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    fake.results = [[{ id: "d-1" }], []];
    generateWithGrokMock.mockResolvedValue("garbage no json here");
    generateTextMock.mockResolvedValue(VALID_SCREENPLAY_JSON);

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay("drama", TEST_DIRECTOR);

    expect(result).not.toBeNull();
    if (result && typeof result !== "string") {
      expect(result.title).toBe("Test Movie");
      expect(result.screenplayProvider).toBe("claude");
    }
    expect(generateTextMock).toHaveBeenCalledOnce();
  });

  it("returns null when both providers fail", async () => {
    isXAIConfiguredMock.mockReturnValue(true);
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    fake.results = [[{ id: "d-1" }], []];
    generateWithGrokMock.mockResolvedValue(null);
    generateTextMock.mockResolvedValue("nothing parseable");

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay("drama", TEST_DIRECTOR);
    expect(result).toBeNull();
  });

  it("assembles intro + credits scenes for standalone movies (no channelId)", async () => {
    isXAIConfiguredMock.mockReturnValue(false);
    fake.results = [[{ id: "d-1" }], []];
    generateTextMock.mockResolvedValue(VALID_SCREENPLAY_JSON);

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay("scifi", TEST_DIRECTOR);

    expect(result).not.toBeNull();
    if (result && typeof result !== "string") {
      // 2 story scenes from JSON + 1 intro + 1 credits = 4 scenes
      expect(result.scenes.length).toBe(4);
      expect(result.scenes[0]!.type).toBe("intro");
      expect(result.scenes[result.scenes.length - 1]!.type).toBe("credits");
      expect(result.totalDuration).toBe(40);
    }
  });

  it("skips bookends entirely for non-Studios channel content", async () => {
    isXAIConfiguredMock.mockReturnValue(false);
    fake.results = [[{ id: "d-1" }], []];
    generateTextMock.mockResolvedValue(VALID_SCREENPLAY_JSON);

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay(
      "drama",
      TEST_DIRECTOR,
      undefined,
      "ch-ai-fail-army",
    );

    expect(result).not.toBeNull();
    if (result && typeof result !== "string") {
      // No intro or credits — just the 2 story scenes
      expect(result.scenes.length).toBe(2);
      expect(result.scenes.every((s) => s.type === "story")).toBe(true);
    }
  });

  it("respects 'N clips' override in customConcept", async () => {
    isXAIConfiguredMock.mockReturnValue(false);
    fake.results = [[{ id: "d-1" }], []];
    generateTextMock.mockResolvedValue(VALID_SCREENPLAY_JSON);

    const { generateDirectorScreenplay } = await import("./director-screenplay");
    const result = await generateDirectorScreenplay(
      "drama",
      TEST_DIRECTOR,
      "make exactly 5 clips please",
      undefined,
      true,
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("exactly 5 STORY scenes");
  });
});
