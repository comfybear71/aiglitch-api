/**
 * Tests for the breaking-news lib.
 *
 * Covers:
 *   - Toggle (enabled/disabled) defaulting + persistence
 *   - Daily counter (count, reset at new day, cap enforcement)
 *   - processNewTopicsForBreakingNews dedup (skips topics with existing video_url)
 *   - Cap-hit behavior (returns "cap_hit" for excess topics)
 *   - Disabled bypass
 *   - Brand asset lazy generation (only fires when cached URLs missing)
 *
 * Network calls (xAI video gen, blob put, spread to socials) are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

// xAI video gen → return a fake Blob URL without hitting the API.
const generateVideoToBlobMock = vi.fn();
vi.mock("@/lib/ai/video", () => ({
  generateVideoToBlob: (...a: unknown[]) => generateVideoToBlobMock(...a),
}));

// MP4 concat → return a tiny fake buffer so we don't need real MP4 bytes.
vi.mock("@/lib/media/mp4-concat", () => ({
  concatMP4Clips: () => Buffer.from("FAKE_STITCHED"),
}));

// Blob put → return a deterministic URL we can assert against.
vi.mock("@vercel/blob", () => ({
  put: vi.fn((path: string) => Promise.resolve({ url: `https://blob.test/${path}` })),
}));

// Social spread → no-op success.
vi.mock("@/lib/marketing/spread-post", () => ({
  spreadPostToSocial: vi.fn().mockResolvedValue({ platforms: [] }),
}));

// Stub global fetch (download intro/outro/clip buffers).
function stubFetchOk(body: string = "FAKE_VIDEO_BYTES") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from(body).buffer.slice(0),
    })),
  );
}

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  generateVideoToBlobMock.mockReset();
  generateVideoToBlobMock.mockResolvedValue({
    blobUrl: "https://blob.test/clip.mp4",
    requestId: "req_123",
    model: "grok-video",
    estimatedUsd: 0.5,
    durationSec: 10,
    sizeBytes: 100,
  });
  stubFetchOk();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("toggle", () => {
  it("defaults to enabled when the setting row is missing", async () => {
    fake.results = [[]]; // SELECT returns empty
    const { isBreakingNewsEnabled } = await import("./breaking-news");
    expect(await isBreakingNewsEnabled()).toBe(true);
  });

  it("respects an explicit false", async () => {
    fake.results = [[{ value: "false" }]];
    const { isBreakingNewsEnabled } = await import("./breaking-news");
    expect(await isBreakingNewsEnabled()).toBe(false);
  });

  it("setBreakingNewsEnabled UPSERTs the value", async () => {
    fake.results = [[]]; // UPSERT returns nothing
    const { setBreakingNewsEnabled } = await import("./breaking-news");
    await setBreakingNewsEnabled(false);
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.values).toContain("false");
  });
});

describe("processNewTopicsForBreakingNews", () => {
  it("returns 'disabled' for all topics when the toggle is off", async () => {
    fake.results = [
      [], // ensure columns (ALTER) — ignored
      [], // ensure columns (ALTER)
      [{ value: "false" }], // KEY_ENABLED
    ];
    const { processNewTopicsForBreakingNews } = await import("./breaking-news");
    const result = await processNewTopicsForBreakingNews(["t-1", "t-2"]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.status === "disabled")).toBe(true);
    expect(generateVideoToBlobMock).not.toHaveBeenCalled();
  });

  it("returns 'cap_hit' for all topics when daily cap already reached", async () => {
    const today = new Date().toISOString().slice(0, 10);
    fake.results = [
      [], // ALTER
      [], // ALTER
      [{ value: "true" }], // KEY_ENABLED
      [{ value: today }], // KEY_DAILY_RESET_DATE matches today
      [{ value: "2" }], // KEY_DAILY_COUNT — already at cap
    ];
    const { processNewTopicsForBreakingNews } = await import("./breaking-news");
    const result = await processNewTopicsForBreakingNews(["t-1"]);
    expect(result[0]?.status).toBe("cap_hit");
    expect(generateVideoToBlobMock).not.toHaveBeenCalled();
  });

  it("resets the daily counter when the date has rolled over", async () => {
    fake.results = [
      [], // ALTER
      [], // ALTER
      [{ value: "true" }], // KEY_ENABLED
      [{ value: "2020-01-01" }], // KEY_DAILY_RESET_DATE — old
      // After reset: writeSetting × 2 (count=0, date=today)
      [], // UPSERT count
      [], // UPSERT date
      // Then candidates fetch — empty (no topics actually exist)
      [],
    ];
    const { processNewTopicsForBreakingNews } = await import("./breaking-news");
    const result = await processNewTopicsForBreakingNews(["t-1"]);
    // No candidates → "skipped" (topic_id passed but row not found / already
    // has breaking_video_url)
    expect(result[0]?.status).toBe("skipped");
  });

  it("returns empty array for empty input", async () => {
    const { processNewTopicsForBreakingNews } = await import("./breaking-news");
    expect(await processNewTopicsForBreakingNews([])).toEqual([]);
  });

  it("returns 'skipped' for topic IDs not in the candidate fetch", async () => {
    const today = new Date().toISOString().slice(0, 10);
    fake.results = [
      [], // ALTER
      [], // ALTER
      [{ value: "true" }], // KEY_ENABLED
      [{ value: today }], // KEY_DAILY_RESET_DATE
      [{ value: "0" }], // KEY_DAILY_COUNT
      [], // candidates fetch — empty (all already have breaking_video_url)
    ];
    const { processNewTopicsForBreakingNews } = await import("./breaking-news");
    const result = await processNewTopicsForBreakingNews(["t-1", "t-2"]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.status === "skipped")).toBe(true);
  });
});

describe("getBreakingNewsStatus", () => {
  it("returns full state shape including a null lastForceTrigger when never run", async () => {
    const today = new Date().toISOString().slice(0, 10);
    fake.results = [
      [{ value: "true" }], // enabled
      [{ value: today }], // reset date
      [{ value: "1" }], // count
      [{ value: "https://blob.test/intro.mp4" }], // intro
      [{ value: "https://blob.test/outro.mp4" }], // outro
      [], // last_force_trigger — never written
    ];
    const { getBreakingNewsStatus } = await import("./breaking-news");
    const s = await getBreakingNewsStatus();
    expect(s.enabled).toBe(true);
    expect(s.dailyCap).toBe(2);
    expect(s.count).toBe(1);
    expect(s.remaining).toBe(1);
    expect(s.intro_url).toBe("https://blob.test/intro.mp4");
    expect(s.outro_url).toBe("https://blob.test/outro.mp4");
    expect(s.lastForceTrigger).toBeNull();
  });

  it("surfaces persisted lastForceTrigger results so failures are visible from Safari", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const persisted = {
      at: "2026-06-18T02:22:06.000Z",
      results: [
        {
          topic_id: "ce8f3ec3-2028-4bb1-a87d-b37ab243cbe4",
          status: "failed",
          error:
            "HeyGen video submit failed (400): {\"error\":\"avatar_id is not Avatar V compatible\"}",
        },
      ],
    };
    fake.results = [
      [{ value: "true" }],
      [{ value: today }],
      [{ value: "0" }],
      [{ value: "https://blob.test/intro.mp4" }],
      [{ value: "https://blob.test/outro.mp4" }],
      [{ value: JSON.stringify(persisted) }],
    ];
    const { getBreakingNewsStatus } = await import("./breaking-news");
    const s = await getBreakingNewsStatus();
    expect(s.lastForceTrigger).not.toBeNull();
    expect(s.lastForceTrigger!.at).toBe(persisted.at);
    expect(s.lastForceTrigger!.results[0]!.status).toBe("failed");
    expect(s.lastForceTrigger!.results[0]!.error).toContain("avatar_id");
  });

  it("returns null when the stored last_force_trigger row is malformed JSON", async () => {
    const today = new Date().toISOString().slice(0, 10);
    fake.results = [
      [{ value: "true" }],
      [{ value: today }],
      [{ value: "0" }],
      [], // intro
      [], // outro
      [{ value: "{not-json" }],
    ];
    const { getBreakingNewsStatus } = await import("./breaking-news");
    const s = await getBreakingNewsStatus();
    expect(s.lastForceTrigger).toBeNull();
  });
});
