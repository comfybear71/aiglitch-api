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

const generateScreenplayMock = vi.fn();
const submitMultiClipJobsMock = vi.fn();
const pollMultiClipJobsMock = vi.fn();
const getMultiClipJobStatusMock = vi.fn();
vi.mock("@/lib/media/multi-clip", () => ({
  generateScreenplay: (...a: unknown[]) => generateScreenplayMock(...a),
  submitMultiClipJobs: (...a: unknown[]) => submitMultiClipJobsMock(...a),
  pollMultiClipJobs: () => pollMultiClipJobsMock(),
  getMultiClipJobStatus: () => getMultiClipJobStatusMock(),
  getAvailableGenres: () => [
    "drama",
    "comedy",
    "scifi",
    "horror",
    "family",
    "documentary",
    "action",
    "romance",
    "music_video",
    "cooking_channel",
  ],
}));

beforeEach(() => {
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron";
  process.env.XAI_API_KEY = "xai-key";
  generateScreenplayMock.mockReset();
  submitMultiClipJobsMock.mockReset();
  pollMultiClipJobsMock.mockReset();
  getMultiClipJobStatusMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callGET(authHeader?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(
    new NextRequest("http://localhost/api/generate-series", {
      headers: new Headers(
        authHeader ? { authorization: authHeader } : {},
      ),
    }),
  );
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/generate-series", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/generate-series", () => {
  it("401 without cron auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns poll result + jobs + genre list with valid cron auth", async () => {
    pollMultiClipJobsMock.mockResolvedValue({
      polled: 2,
      completed: 1,
      stitched: ["job-1"],
    });
    getMultiClipJobStatusMock.mockResolvedValue([{ id: "j1", title: "Test" }]);

    const res = await callGET("Bearer test-cron");
    const body = (await res.json()) as {
      polled: number;
      completed: number;
      stitched: string[];
      jobs: { id: string }[];
      availableGenres: string[];
    };
    expect(body.polled).toBe(2);
    expect(body.completed).toBe(1);
    expect(body.jobs[0]!.id).toBe("j1");
    expect(body.availableGenres).toContain("drama");
  });
});

describe("POST /api/generate-series", () => {
  it("401 without admin auth", async () => {
    expect((await callPOST({})).status).toBe(401);
  });

  it("400 without XAI_API_KEY", async () => {
    mockIsAdmin = true;
    delete process.env.XAI_API_KEY;
    expect((await callPOST({ genre: "drama" })).status).toBe(400);
  });

  it("400 for invalid genre", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ genre: "invalid-genre" });
    expect(res.status).toBe(400);
  });

  it("400 when no active personas exist and persona_id not given", async () => {
    mockIsAdmin = true;
    fake.results = [[]]; // empty persona lookup
    const res = await callPOST({ genre: "drama" });
    expect(res.status).toBe(400);
  });

  it("500 when screenplay generation returns null", async () => {
    mockIsAdmin = true;
    fake.results = [[{ id: "p-1" }]];
    generateScreenplayMock.mockResolvedValue(null);
    const res = await callPOST({ genre: "drama" });
    expect(res.status).toBe(500);
  });

  it("500 when submitMultiClipJobs returns null", async () => {
    mockIsAdmin = true;
    fake.results = [[{ id: "p-1" }]];
    generateScreenplayMock.mockResolvedValue({
      id: "s-1",
      title: "T",
      tagline: "x",
      synopsis: "x",
      genre: "drama",
      clipCount: 4,
      scenes: [],
      totalDuration: 40,
    });
    submitMultiClipJobsMock.mockResolvedValue(null);
    const res = await callPOST({ genre: "drama" });
    expect(res.status).toBe(500);
  });

  it("happy path returns jobId + screenplay summary", async () => {
    mockIsAdmin = true;
    fake.results = [[{ id: "px" }]];
    generateScreenplayMock.mockResolvedValue({
      id: "s-1",
      title: "Cool Film",
      tagline: "tagline",
      synopsis: "synopsis",
      genre: "scifi",
      clipCount: 4,
      scenes: [
        { sceneNumber: 1, title: "Open", description: "d", videoPrompt: "p", duration: 10 },
      ],
      totalDuration: 40,
    });
    submitMultiClipJobsMock.mockResolvedValue("job-1");

    const res = await callPOST({ genre: "scifi", clips: 4 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      jobId: string;
      screenplay: { title: string };
      personaId: string;
    };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe("job-1");
    expect(body.screenplay.title).toBe("Cool Film");
    expect(body.personaId).toBe("px");
  });

  it("clamps clip count between 2 and 6", async () => {
    mockIsAdmin = true;
    fake.results = [[{ id: "px" }]];
    generateScreenplayMock.mockResolvedValue({
      id: "s",
      title: "x",
      tagline: "x",
      synopsis: "x",
      genre: "drama",
      clipCount: 6,
      scenes: [],
      totalDuration: 60,
    });
    submitMultiClipJobsMock.mockResolvedValue("job-2");

    await callPOST({ genre: "drama", clips: 99 });
    expect(generateScreenplayMock).toHaveBeenCalledWith("drama", 6, undefined);
  });
});
