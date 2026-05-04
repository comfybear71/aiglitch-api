import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const putMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...a: unknown[]) => putMock(...a),
}));

const generateImageMock = vi.fn();
vi.mock("@/lib/ai/image", () => ({
  generateImage: (...a: unknown[]) => generateImageMock(...a),
}));

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...a: unknown[]) => generateTextMock(...a),
}));

const injectCampaignPlacementMock = vi.fn();
vi.mock("@/lib/ad-campaigns", () => ({
  injectCampaignPlacement: (...a: unknown[]) =>
    injectCampaignPlacementMock(...a),
}));

const concatMP4ClipsMock = vi.fn();
vi.mock("@/lib/media/mp4-concat", () => ({
  concatMP4Clips: (...a: unknown[]) => concatMP4ClipsMock(...a),
}));

const extendVideoFromFrameMock = vi.fn();
vi.mock("@/lib/ai/xai-extras", () => ({
  extendVideoFromFrame: (...a: unknown[]) => extendVideoFromFrameMock(...a),
}));

const GENRE_TEMPLATES = {
  drama: {
    cinematicStyle: "Moody, intimate cinematography",
    moodTone: "Contemplative",
    lightingDesign: "Soft, natural lighting",
    technicalValues: "24fps, color graded",
  },
};
vi.mock("@/lib/media/multi-clip", () => ({
  GENRE_TEMPLATES,
}));

beforeEach(() => {
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.XAI_API_KEY = "xai-key";
  generateImageMock.mockReset();
  generateTextMock.mockReset();
  injectCampaignPlacementMock.mockReset();
  extendVideoFromFrameMock.mockReset();
  putMock.mockReset();
  concatMP4ClipsMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/admin/extend-video", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

async function callGET(requestId: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(
    new NextRequest(
      `http://localhost/api/admin/extend-video?requestId=${requestId}`,
    ),
  );
}

async function callPUT(body: unknown) {
  vi.resetModules();
  const { PUT } = await import("./route");
  const { NextRequest } = await import("next/server");
  return PUT(
    new NextRequest("http://localhost/api/admin/extend-video", {
      method: "PUT",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/admin/extend-video", () => {
  it("returns 401 when not authenticated", async () => {
    mockIsAdmin = false;
    const res = await callPOST({ movieId: "movie-1" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when movieId is missing", async () => {
    mockIsAdmin = true;
    const res = await callPOST({});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("movieId");
  });

  it("returns 404 when movie not found", async () => {
    mockIsAdmin = true;
    fake.results = [[]]; // Empty query result
    const res = await callPOST({ movieId: "movie-1" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when movie has no video URL", async () => {
    mockIsAdmin = true;
    fake.results = [
      [
        {
          id: "movie-1",
          title: "Test Movie",
          genre: "drama",
          director_id: "dir-1",
          director_username: "director",
          post_id: null,
          premiere_post_id: null,
          video_url: null,
          caption: "Test caption",
        },
      ],
    ];
    const res = await callPOST({ movieId: "movie-1" });
    expect(res.status).toBe(400);
  });

  it("succeeds with extension jobs on valid movie", async () => {
    mockIsAdmin = true;
    const movieData = {
      id: "movie-1",
      title: "Test Movie",
      genre: "drama",
      director_id: "dir-1",
      director_username: "director",
      post_id: "post-1",
      premiere_post_id: null,
      video_url: "https://cdn/original.mp4",
      caption: "Test caption",
    };
    fake.results = [
      [movieData], // Movie query
      [], // Multi-clip job query
    ];

    generateImageMock.mockResolvedValue({
      imageUrl: "https://cdn/frame.png",
      model: "grok-imagine-image",
      estimatedUsd: 0.02,
    });

    generateTextMock.mockResolvedValue(
      JSON.stringify({
        scenes: [
          {
            sceneNumber: 1,
            title: "Scene 1",
            video_prompt: "Continuing from the previous shot...",
          },
        ],
      }),
    );

    injectCampaignPlacementMock.mockResolvedValue({
      prompt: "Continuing from the previous shot... with ad",
    });

    extendVideoFromFrameMock.mockResolvedValue({
      requestId: "ext-123",
      videoUrl: null,
      error: null,
    });

    const res = await callPOST({ movieId: "movie-1" });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      movieId: string;
      extensionJobs: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.movieId).toBe("movie-1");
    expect(body.extensionJobs.length).toBeGreaterThan(0);
  });
});

describe("GET /api/admin/extend-video", () => {
  it("returns 401 when not authenticated", async () => {
    mockIsAdmin = false;
    const res = await callGET("req-123");
    expect(res.status).toBe(401);
  });

  it("returns 400 when requestId is missing", async () => {
    mockIsAdmin = true;
    const res = await callGET("");
    expect(res.status).toBe(400);
  });

  it("returns pending status", async () => {
    mockIsAdmin = true;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "processing",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callGET("req-123");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("processing");
  });
});

describe("PUT /api/admin/extend-video", () => {
  it("returns 401 when not authenticated", async () => {
    mockIsAdmin = false;
    const res = await callPUT({
      movieId: "movie-1",
      originalVideoUrl: "https://cdn/orig.mp4",
      extensionVideoUrls: ["https://cdn/ext1.mp4"],
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    mockIsAdmin = true;
    const res = await callPUT({ movieId: "movie-1" });
    expect(res.status).toBe(400);
  });

  it("stitches clips and updates post on success", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ post_id: "post-1" }], // Query for post_id
    ];

    const stitchedBuffer = Buffer.from("stitched-video-data");
    concatMP4ClipsMock.mockReturnValue(stitchedBuffer);

    putMock.mockResolvedValue({ url: "https://blob/extended.mp4" });

    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPUT({
      movieId: "movie-1",
      originalVideoUrl: "https://cdn/orig.mp4",
      extensionVideoUrls: ["https://cdn/ext1.mp4"],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      extendedVideoUrl: string;
    };
    expect(body.success).toBe(true);
    expect(body.extendedVideoUrl).toBe("https://blob/extended.mp4");
  });
});
