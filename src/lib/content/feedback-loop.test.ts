import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const generateHintMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateFeedbackHint: (...args: unknown[]) => generateHintMock(...args),
}));

const CHANNEL_WITH_REACTIONS = {
  channel_id: "ch-1",
  channel_name: "Tech News",
  channel_slug: "tech",
  total_funny: 15,
  total_shocked: 8,
  total_sad: 2,
  total_crap: 3,
  avg_score: 2.4,
};

const CHANNEL_LOW_SIGNAL = {
  channel_id: "ch-2",
  channel_name: "Quiet Channel",
  channel_slug: "quiet",
  total_funny: 1,
  total_shocked: 1,
  total_sad: 0,
  total_crap: 0,
  avg_score: 1.5,
};

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  generateHintMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function loadAndRun() {
  const { runFeedbackLoop } = await import("./feedback-loop");
  return runFeedbackLoop();
}

describe("runFeedbackLoop", () => {
  it("returns zero counts when no channels have reaction data", async () => {
    fake.results = [
      [],  // channelStats → empty
      [],  // UPDATE content_feedback (stale rescore)
    ];
    const result = await loadAndRun();
    expect(result.channelsUpdated).toBe(0);
    expect(result.channelsSkipped).toBe(0);
    expect(result.details).toEqual([]);
    expect(generateHintMock).not.toHaveBeenCalled();
  });

  it("skips channels with <5 total reactions", async () => {
    fake.results = [
      [CHANNEL_LOW_SIGNAL],  // channelStats
      [],                    // top posts
      [],                    // worst posts
      [],                    // UPDATE content_feedback
    ];
    const result = await loadAndRun();
    expect(result.channelsUpdated).toBe(0);
    expect(result.channelsSkipped).toBe(1);
    expect(generateHintMock).not.toHaveBeenCalled();
  });

  it("updates channel.content_rules when hint is generated", async () => {
    generateHintMock.mockResolvedValue("lean into hot takes, avoid generic news recaps");
    fake.results = [
      [CHANNEL_WITH_REACTIONS],  // channelStats
      [                          // top posts
        { content: "hot take banger", post_type: "hot_take", score: 12, funny_count: 4, shocked_count: 0, sad_count: 0, crap_count: 0 },
      ],
      [],                        // worst posts — none
      [{ content_rules: JSON.stringify({ tone: "edgy" }) }], // SELECT existing rules
      [],                        // UPDATE channels
      [],                        // UPDATE content_feedback rescore
    ];

    const result = await loadAndRun();
    expect(result.channelsUpdated).toBe(1);
    expect(result.channelsSkipped).toBe(0);
    expect(result.details[0]).toMatchObject({
      channel: "tech",
      totalReactions: 28,
      hint: "lean into hot takes, avoid generic news recaps",
    });
    expect(generateHintMock).toHaveBeenCalledOnce();
  });

  it("handles null content_rules gracefully (starts fresh object)", async () => {
    generateHintMock.mockResolvedValue("more chaos");
    fake.results = [
      [CHANNEL_WITH_REACTIONS],
      [], [],
      [{ content_rules: null }],   // null rules
      [],                          // UPDATE channels
      [],                          // UPDATE content_feedback
    ];
    const result = await loadAndRun();
    expect(result.channelsUpdated).toBe(1);
  });

  it("skips channel when hint generation returns empty string", async () => {
    generateHintMock.mockResolvedValue("");
    fake.results = [
      [CHANNEL_WITH_REACTIONS],
      [], [],
      [],  // UPDATE content_feedback rescore
    ];
    const result = await loadAndRun();
    expect(result.channelsUpdated).toBe(0);
    expect(result.channelsSkipped).toBe(1);
  });

  it("skips and keeps going when one channel's hint call throws", async () => {
    generateHintMock.mockRejectedValueOnce(new Error("model timeout"));
    fake.results = [
      [CHANNEL_WITH_REACTIONS],
      [], [],
      [],  // UPDATE content_feedback rescore
    ];
    const result = await loadAndRun();
    expect(result.channelsUpdated).toBe(0);
    expect(result.channelsSkipped).toBe(1);
  });
});
