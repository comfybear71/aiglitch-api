import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockCronAuth = false;
vi.mock("@/lib/cron-auth", () => ({
  checkCronAuth: () => Promise.resolve(mockCronAuth),
}));

const generateMovieTrailersMock = vi.fn();
vi.mock("@/lib/content/ai-engine", () => ({
  generateMovieTrailers: (...a: unknown[]) => generateMovieTrailersMock(...a),
}));

const spreadPostToSocialMock = vi.fn();
vi.mock("@/lib/marketing/spread-post", () => ({
  spreadPostToSocial: (...a: unknown[]) => spreadPostToSocialMock(...a),
}));

beforeEach(() => {
  fake.results = [];
  mockCronAuth = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron";
  generateMovieTrailersMock.mockReset();
  spreadPostToSocialMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/generate-movies", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/generate-movies"));
}

describe("POST /api/generate-movies", () => {
  it("returns 401 when not cron authenticated", async () => {
    mockCronAuth = false;
    const res = await callPOST({});
    expect(res.status).toBe(401);
  });

  it("returns 500 when no active personas found", async () => {
    mockCronAuth = true;
    fake.results = [[], []]; // Both queries return empty
    const res = await callPOST({});
    expect(res.status).toBe(500);
  });

  it("generates and posts movies successfully", async () => {
    mockCronAuth = true;
    const persona = {
      id: "p-1",
      username: "aiglitch_studios",
      display_name: "AIG!itch Studios",
      avatar_emoji: "🎬",
    };
    fake.results = [[persona]]; // Studio persona exists

    generateMovieTrailersMock.mockResolvedValue([
      {
        title: "Test Movie",
        tagline: "Test tagline",
        synopsis: "Test synopsis",
        genre: "action",
        rating: "PG-13",
        content: "Test content",
        hashtags: ["AIGlitchPremieres", "AIGlitchAction"],
        post_type: "premiere",
        video_prompt: "test prompt",
        media_url: "https://blob/movie.mp4",
        media_type: "video",
        media_source: "grok-video",
      },
    ]);

    const res = await callPOST({ genre: "action", count: 1 });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      generated: number;
      movies: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.generated).toBe(1);
    expect(body.movies).toHaveLength(1);
  });

  it("respects genre filter and count limits", async () => {
    mockCronAuth = true;
    fake.results = [[{ id: "p-1", username: "test", display_name: "Test", avatar_emoji: "🎭" }]];

    generateMovieTrailersMock.mockResolvedValue([]);

    await callPOST({ genre: "scifi", count: 10 });

    expect(generateMovieTrailersMock).toHaveBeenCalledWith("scifi", 6); // Clamped to 6
  });

  it("spreads videos to social platforms on success", async () => {
    mockCronAuth = true;
    const persona = {
      id: "p-1",
      username: "test",
      display_name: "Test",
      avatar_emoji: "🎭",
    };
    fake.results = [[persona]];

    generateMovieTrailersMock.mockResolvedValue([
      {
        title: "Social Movie",
        tagline: "test",
        synopsis: "test",
        genre: "drama",
        rating: "R",
        content: "test",
        hashtags: ["AIGlitchPremieres"],
        post_type: "premiere",
        video_prompt: "test",
        media_url: "https://blob/movie.mp4",
        media_type: "video",
        media_source: "grok-video",
      },
    ]);

    const res = await callPOST({});
    expect(res.status).toBe(200);
    expect(spreadPostToSocialMock).toHaveBeenCalled();
  });
});

describe("GET /api/generate-movies", () => {
  it("returns 401 when not cron authenticated", async () => {
    mockCronAuth = false;
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("delegates to POST with default count", async () => {
    mockCronAuth = true;
    fake.results = [[{ id: "p-1", username: "test", display_name: "Test", avatar_emoji: "🎭" }]];
    generateMovieTrailersMock.mockResolvedValue([]);

    const res = await callGET();
    expect(res.status).toBe(200);
    expect(generateMovieTrailersMock).toHaveBeenCalledWith(undefined, 4);
  });
});
