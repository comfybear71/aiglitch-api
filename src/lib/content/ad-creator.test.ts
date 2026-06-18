/**
 * Tests for the Ad Creator generation pipeline.
 *
 * Network calls (Claude, HeyGen, Grok, blob put, ffmpeg, DB insert)
 * are stubbed — these specs cover orchestration, cost preflight,
 * persistence of the diagnostic surface, and error paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake DB (sql tagged template) ──────────────────────────────────
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as (unknown[] | Error)[],
};
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

// ── Stub the heavy network surfaces ────────────────────────────────
const generateJSONMock = vi.fn();
vi.mock("@/lib/ai/claude", () => ({
  generateJSON: (...a: unknown[]) => generateJSONMock(...a),
}));

const generateAvatarVideoToBlobMock = vi.fn();
vi.mock("@/lib/ai/heygen", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/heygen")>("@/lib/ai/heygen");
  return {
    ...actual,
    generateAvatarVideoToBlob: (...a: unknown[]) =>
      generateAvatarVideoToBlobMock(...a),
  };
});

const generateVideoToBlobMock = vi.fn();
vi.mock("@/lib/ai/video", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/video")>("@/lib/ai/video");
  return {
    ...actual,
    generateVideoToBlob: (...a: unknown[]) => generateVideoToBlobMock(...a),
  };
});

vi.mock("@/lib/media/ffmpeg-stitch", () => ({
  stitchClipsWithReencode: vi.fn(async () => Buffer.from("FAKE_STITCHED")),
}));

const putMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (path: string, ...rest: unknown[]) => putMock(path, ...rest),
}));

// fetch (download to buffer) returns tiny array buffers.
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })),
  );
}

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.HEYGEN_API_KEY = "key";
  process.env.HEYGEN_NEWS_ANCHOR_AVATAR_ID = "av-1";
  process.env.HEYGEN_NEWS_ANCHOR_VOICE_ID = "vc-1";

  generateJSONMock.mockReset();
  generateAvatarVideoToBlobMock.mockReset();
  generateVideoToBlobMock.mockReset();
  putMock.mockReset();
  putMock.mockImplementation(async (path: string) => ({
    url: `https://blob.test/${path}`,
  }));
  stubFetch();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.HEYGEN_API_KEY;
  delete process.env.HEYGEN_NEWS_ANCHOR_AVATAR_ID;
  delete process.env.HEYGEN_NEWS_ANCHOR_VOICE_ID;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function briefRow() {
  return {
    id: "b-1",
    title: "BUDJU explainer",
    project_name: "BUDJU",
    concept: "Explain DCA tiers in 30 seconds.",
    status: "draft",
    target_socials: null,
    last_video_url: null,
    last_post_id: null,
    last_error: null,
    last_generation_at: null,
    generation_log: null,
    created_at: "now",
    updated_at: "now",
  };
}

function withSchemaRows(...rows: (unknown[] | Error)[]): (unknown[] | Error)[] {
  // 1 CREATE TABLE briefs + 2 indexes + 5 ALTERs + 1 CREATE TABLE assets +
  // 1 index = 10 schema statements.
  return [...Array(10).fill([]), ...rows];
}

describe("estimateScriptCost", () => {
  it("anchor + scenes pricing math", async () => {
    const { estimateScriptCost } = await import("./ad-creator");
    const est = estimateScriptCost({
      anchorScript: "x",
      scenes: ["a", "b", "c"],
    });
    expect(est.scenes).toBe(3);
    // 3 scenes × 10s × $0.07/s (Grok 1.0 @ 720p) = $2.10
    expect(est.bRollUsd).toBeCloseTo(2.1, 3);
    // 10s × $0.0167 = $0.167
    expect(est.anchorUsd).toBeCloseTo(0.167, 3);
    // Total ~ $2.27
    expect(est.totalUsd).toBeCloseTo(2.267, 3);
  });
});

describe("generateAdFromBrief — pre-flight errors", () => {
  it("throws when HEYGEN_API_KEY missing", async () => {
    delete process.env.HEYGEN_API_KEY;
    const { generateAdFromBrief } = await import("./ad-creator");
    await expect(generateAdFromBrief("b-1")).rejects.toThrow(/HEYGEN_API_KEY/);
  });

  it("throws when avatar id missing (env + no override)", async () => {
    delete process.env.HEYGEN_NEWS_ANCHOR_AVATAR_ID;
    const { generateAdFromBrief } = await import("./ad-creator");
    await expect(generateAdFromBrief("b-1")).rejects.toThrow(/avatar id missing/);
  });

  it("throws when brief not found", async () => {
    fake.results = withSchemaRows(
      [], // SELECT brief → empty
    );
    const { generateAdFromBrief } = await import("./ad-creator");
    await expect(generateAdFromBrief("missing")).rejects.toThrow(/not found/);
  });

  it("explicit avatarId / voiceId override unblocks when env vars are missing", async () => {
    delete process.env.HEYGEN_NEWS_ANCHOR_AVATAR_ID;
    delete process.env.HEYGEN_NEWS_ANCHOR_VOICE_ID;
    fake.results = withSchemaRows(
      [briefRow()], // SELECT brief
      [], // listAssetsForBrief
      [], // updateBrief → status='generating'
      [], // recordGenerationResult → UPDATE
    );
    generateJSONMock.mockResolvedValue({
      anchorScript: "x",
      scenes: ["s1"],
    });
    generateAvatarVideoToBlobMock.mockResolvedValue({
      blobUrl: "https://blob/anchor.mp4",
      estimatedUsd: 0.17,
      durationSec: 10,
    });
    generateVideoToBlobMock.mockResolvedValue({
      blobUrl: "https://blob/scene.mp4",
      estimatedUsd: 0.7,
      durationSec: 10,
    });

    const { generateAdFromBrief } = await import("./ad-creator");
    const res = await generateAdFromBrief("b-1", {
      avatarId: "override-av",
      voiceId: "override-vc",
    });
    expect(res.status).toBe("posted");
    expect(generateAvatarVideoToBlobMock).toHaveBeenCalledWith(
      expect.objectContaining({ avatarId: "override-av", voiceId: "override-vc" }),
    );
  });
});

describe("generateAdFromBrief — happy path", () => {
  it("runs claude → heygen + grok parallel → ffmpeg → blob → feed insert", async () => {
    fake.results = withSchemaRows(
      [briefRow()], // SELECT brief
      [], // listAssetsForBrief → no assets
      [], // updateBrief → 'generating'
      [], // INSERT posts
      [], // recordGenerationResult UPDATE
    );
    generateJSONMock.mockResolvedValue({
      anchorScript: "BUDJU announces DCA tiers — the easiest crypto entry yet.",
      scenes: ["scene 1", "scene 2"],
    });
    generateAvatarVideoToBlobMock.mockResolvedValue({
      blobUrl: "https://blob/anchor.mp4",
      estimatedUsd: 0.17,
      durationSec: 10,
    });
    generateVideoToBlobMock.mockResolvedValue({
      blobUrl: "https://blob/scene.mp4",
      estimatedUsd: 0.7,
      durationSec: 10,
    });

    const { generateAdFromBrief } = await import("./ad-creator");
    const res = await generateAdFromBrief("b-1");
    expect(res.status).toBe("posted");
    expect(res.video_url).toMatch(/blob\.test\/ad-briefs\/b-1\/generations\/.*\/final\.mp4/);
    expect(res.post_id).toBeDefined();

    expect(generateJSONMock).toHaveBeenCalledOnce();
    expect(generateAvatarVideoToBlobMock).toHaveBeenCalledOnce();
    // Two scenes were generated in parallel.
    expect(generateVideoToBlobMock).toHaveBeenCalledTimes(2);
    expect(putMock).toHaveBeenCalledOnce();

    // Diagnostic log contains the expected steps.
    const steps = res.log.map((l) => l.step);
    expect(steps).toEqual(
      expect.arrayContaining([
        "claude_script",
        "cost_estimate",
        "heygen_anchor",
        "grok_scene_0",
        "grok_scene_1",
        "ffmpeg_stitch",
        "blob_upload",
        "feed_post_insert",
      ]),
    );
  });
});

describe("generateAdFromBrief — failure paths", () => {
  it("returns status:failed and persists when Claude script unusable", async () => {
    fake.results = withSchemaRows(
      [briefRow()],
      [], // listAssets
      [], // updateBrief → 'generating'
      [], // recordGenerationResult UPDATE
    );
    generateJSONMock.mockResolvedValue(null);
    const { generateAdFromBrief } = await import("./ad-creator");
    const res = await generateAdFromBrief("b-1");
    expect(res.status).toBe("failed");
    expect(res.error).toContain("Claude script generation");
  });

  it("bails on cost cap exceeded BEFORE calling HeyGen or Grok", async () => {
    fake.results = withSchemaRows(
      [briefRow()],
      [],
      [], // 'generating'
      [], // recordGenerationResult UPDATE
    );
    generateJSONMock.mockResolvedValue({
      anchorScript: "x",
      scenes: ["a", "b", "c"], // 3 × $0.70 = $2.10 + $0.17 = $2.27
    });
    const { generateAdFromBrief } = await import("./ad-creator");
    // Cap below our estimate, so it should refuse to start.
    const res = await generateAdFromBrief("b-1", { maxCostUsd: 1.0 });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("exceeds cap");
    expect(generateAvatarVideoToBlobMock).not.toHaveBeenCalled();
    expect(generateVideoToBlobMock).not.toHaveBeenCalled();
  });

  it("returns status:failed when HeyGen throws", async () => {
    fake.results = withSchemaRows(
      [briefRow()],
      [],
      [], // 'generating'
      [], // recordGenerationResult UPDATE
    );
    generateJSONMock.mockResolvedValue({
      anchorScript: "x",
      scenes: ["a"],
    });
    generateAvatarVideoToBlobMock.mockRejectedValue(
      new Error("HeyGen video submit failed (404): avatar_not_found"),
    );
    generateVideoToBlobMock.mockResolvedValue({
      blobUrl: "https://blob/scene.mp4",
      estimatedUsd: 0.7,
      durationSec: 10,
    });
    const { generateAdFromBrief } = await import("./ad-creator");
    const res = await generateAdFromBrief("b-1");
    expect(res.status).toBe("failed");
    expect(res.error).toContain("avatar_not_found");
  });
});
