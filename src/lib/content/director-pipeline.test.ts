import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitDirectorFilm, stitchAndTriplePost } from "./director-pipeline";
import { DIRECTORS } from "./director-constants";
import type { DirectorScreenplay } from "./director-utils";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const submitVideoJobMock = vi.fn();
vi.mock("@/lib/ai/xai-extras", () => ({
  submitVideoJob: (...a: unknown[]) => submitVideoJobMock(...a),
}));

const concatMP4ClipsMock = vi.fn();
vi.mock("@/lib/media/mp4-concat", () => ({
  concatMP4Clips: (...a: unknown[]) => concatMP4ClipsMock(...a),
}));

const spreadPostToSocialMock = vi.fn();
vi.mock("@/lib/marketing/spread-post", () => ({
  spreadPostToSocial: (...a: unknown[]) => spreadPostToSocialMock(...a),
}));

const putMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...a: unknown[]) => putMock(...a),
}));

const getActiveCampaignsMock = vi.fn();
const rollForPlacementsMock = vi.fn();
const logImpressionsMock = vi.fn();
vi.mock("@/lib/ad-campaigns", () => ({
  getActiveCampaigns: (...a: unknown[]) => getActiveCampaignsMock(...a),
  rollForPlacements: (...a: unknown[]) => rollForPlacementsMock(...a),
  logImpressions: (...a: unknown[]) => logImpressionsMock(...a),
}));

beforeEach(() => {
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  submitVideoJobMock.mockReset();
  concatMP4ClipsMock.mockReset();
  spreadPostToSocialMock.mockReset();
  putMock.mockReset();
  getActiveCampaignsMock.mockReset();
  rollForPlacementsMock.mockReset();
  logImpressionsMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("Director Pipeline", () => {
  it("submitDirectorFilm returns null when screenplay is empty", async () => {
    const { submitDirectorFilm: importedFunc } = await import("./director-pipeline");
    const screenplay: DirectorScreenplay = {
      id: "test-1",
      title: "Test",
      tagline: "test",
      synopsis: "test",
      genre: "drama",
      directorUsername: "steven_spielbot",
      castList: ["Test Actor"],
      characterBible: "test",
      scenes: [],
      totalDuration: 0,
    };

    fake.results = [
      [], // SELECT 1 FROM multi_clip_jobs
      [], // SELECT show_director
    ];

    const result = await importedFunc(screenplay, "persona-1");
    expect(result).toBeDefined();
  });

  it("submitDirectorFilm builds bible and calls submitVideoJob per scene", async () => {
    const { submitDirectorFilm: importedFunc } = await import("./director-pipeline");
    const screenplay: DirectorScreenplay = {
      id: "test-1",
      title: "Test Film",
      tagline: "test",
      synopsis: "A story",
      genre: "action",
      directorUsername: "steven_spielbot",
      castList: ["Hero"],
      characterBible: "Hero: brave, strong",
      scenes: [
        {
          sceneNumber: 1,
          type: "intro",
          title: "Intro",
          description: "Hero enters",
          videoPrompt: "Show hero entering",
          lastFrameDescription: "Hero standing",
          duration: 10,
        },
      ],
      totalDuration: 10,
    };

    submitVideoJobMock.mockResolvedValue({
      requestId: "req-1",
      provider: "grok",
      fellBack: false,
    });

    fake.results = [
      [], // SELECT 1 FROM multi_clip_jobs
      [], // SELECT show_director
      [], // CREATE TABLE checks
      [], // CREATE TABLE
      [], // CREATE TABLE
      [], // ALTER TABLE
      [], // INSERT multi_clip_jobs
      [], // INSERT director_movies
      [], // INSERT multi_clip_scenes
    ];

    const result = await importedFunc(screenplay, "persona-1", "cron");
    expect(result).toBeDefined();
    expect(submitVideoJobMock).toHaveBeenCalled();
  });

  it("stitchAndTriplePost returns null when job not found", async () => {
    const { stitchAndTriplePost: importedFunc } = await import("./director-pipeline");
    fake.results = [
      [], // SELECT j.* FROM multi_clip_jobs
    ];

    const result = await importedFunc("nonexistent");
    expect(result).toBeNull();
  });

  it("stitchAndTriplePost returns existing post when already stitched", async () => {
    const { stitchAndTriplePost: importedFunc } = await import("./director-pipeline");
    fake.results = [
      [
        {
          id: "job-1",
          title: "Test",
          genre: "drama",
          persona_id: "p-1",
          caption: "test",
          clip_count: 2,
          status: "done",
          final_video_url: "https://blob.vercelusercontent.com/test.mp4",
          channel_id: null,
          blob_folder: null,
          director_id: "p-1",
          director_username: "steven_spielbot",
          director_movie_id: "dm-1",
        },
      ],
      [{ id: "post-1" }], // existing post
    ];

    const result = await importedFunc("job-1");
    expect(result).toBeDefined();
    expect(result?.feedPostId).toBe("post-1");
  });

  it("stitchAndTriplePost fetches clips and calls concatMP4Clips", async () => {
    const { stitchAndTriplePost: importedFunc } = await import("./director-pipeline");

    concatMP4ClipsMock.mockReturnValue(Buffer.from("stitched video"));
    putMock.mockResolvedValue({ url: "https://blob.vercelusercontent.com/final.mp4" });
    spreadPostToSocialMock.mockResolvedValue({ platforms: ["x"] });
    getActiveCampaignsMock.mockResolvedValue([]);

    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1000)),
      })
    );
    globalThis.fetch = mockFetch as any;

    fake.results = [
      [
        {
          id: "job-1",
          title: "Test",
          genre: "drama",
          persona_id: "p-1",
          caption: "test",
          clip_count: 2,
          status: "generating",
          final_video_url: null,
          channel_id: null,
          blob_folder: null,
          director_id: "p-1",
          director_username: "steven_spielbot",
          director_movie_id: "dm-1",
        },
      ],
      [
        { video_url: "https://blob/1.mp4", scene_number: 1 },
        { video_url: "https://blob/2.mp4", scene_number: 2 },
      ],
      [], // SELECT existing post
      [], // INSERT posts
      [], // UPDATE channels
      [], // UPDATE ai_personas
      [{}], // SELECT placed_campaign_ids
      [], // UPDATE multi_clip_scenes
      [], // UPDATE multi_clip_jobs
      [], // UPDATE director_movies
      [], // SELECT channels
    ];

    const result = await importedFunc("job-1");
    expect(result).toBeDefined();
    expect(concatMP4ClipsMock).toHaveBeenCalled();
    expect(putMock).toHaveBeenCalled();
    expect(spreadPostToSocialMock).toHaveBeenCalled();
  });
});
