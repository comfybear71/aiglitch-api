import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickDirector, pickGenre, buildContinuityPrompt, getMovieConcept, type MovieBible } from "./director-utils";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("Director Utils", () => {
  it("pickDirector returns shape {id, username, displayName} from db", async () => {
    fake.results = [
      [], // Empty director_movies query
      [{ id: "p-1", username: "steven_spielbot", display_name: "Steven Spielbot" }],
    ];

    const result = await pickDirector("family");
    expect(result).toEqual({
      id: "p-1",
      username: "steven_spielbot",
      displayName: "Steven Spielbot",
    });
  });

  it("pickDirector returns null when persona not found", async () => {
    fake.results = [
      [], // Empty director_movies query
      [], // Empty ai_personas query
    ];

    const result = await pickDirector("action");
    expect(result).toBeNull();
  });

  it("pickGenre returns one of the known genres", async () => {
    fake.results = [
      [], // Empty director_movies query
    ];

    const result = await pickGenre();
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("buildContinuityPrompt includes movie title and clip position", () => {
    const movieBible: MovieBible = {
      title: "Test Movie",
      synopsis: "A test story",
      genre: "action",
      characterBible: "Main character: Alex, 30s, confident",
      directorStyleGuide: "Steven Spielbot style",
      scenes: [
        {
          sceneNumber: 1,
          title: "Opening",
          description: "Alex enters the room",
          videoPrompt: "Show a confident character entering",
          lastFrameDescription: "Alex stands in center of room",
        },
      ],
    };

    const genreTemplate = {
      genre: "action",
      cinematicStyle: "Action-packed",
      moodTone: "High tension",
      lightingDesign: "Dynamic",
      technicalValues: "4K",
      screenplayInstructions: "Fast paced",
    };

    const prompt = buildContinuityPrompt(
      movieBible,
      1,
      3,
      "Show Alex entering the room",
      null,
      null,
      genreTemplate,
    );

    expect(prompt).toContain("Test Movie");
    expect(prompt).toContain("CLIP 1 OF 3");
    expect(prompt).toContain("OPENING CLIP");
  });

  it("getMovieConcept returns null when sql is empty", async () => {
    fake.results = [
      [], // Empty director_movie_prompts query
      [], // Empty 'any' query
    ];

    const result = await getMovieConcept("action");
    expect(result).toBeNull();
  });

  it("getMovieConcept returns row when sql returns one", async () => {
    fake.results = [
      [
        {
          id: "prompt-1",
          title: "Space Adventure",
          concept: "A hero travels through space",
        },
      ],
      // Don't need to add update or second query since it found one
    ];

    const result = await getMovieConcept("scifi");
    expect(result).toEqual({
      id: "prompt-1",
      title: "Space Adventure",
      concept: "A hero travels through space",
    });
  });
});
