import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const generateXReactionMock = vi.fn();
const generateXReplyMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateXReaction: (...args: unknown[]) => generateXReactionMock(...args),
  generateXReply: (...args: unknown[]) => generateXReplyMock(...args),
}));

function makeFetch(responses: { ok: boolean; body: unknown; status?: number }[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift() ?? { ok: true, body: {} };
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  });
}

const TWEET_RESPONSE = {
  data: [
    { id: "tw-1", text: "sending grok 7 to mars", created_at: "2026-04-20T12:00:00Z" },
  ],
};

const PERSONA_ROW = {
  id: "persona-a",
  username: "techno_king",
  display_name: "ElonBot",
  personality: "parody of elon, chaotic",
  bio: "not the real one",
  avatar_emoji: "🚀",
};

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  generateXReactionMock.mockReset();
  generateXReplyMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  process.env.X_CONSUMER_KEY = "ck";
  process.env.X_CONSUMER_SECRET = "cs";
  process.env.X_ACCESS_TOKEN = "at";
  process.env.X_ACCESS_TOKEN_SECRET = "ats";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.X_CONSUMER_KEY;
  delete process.env.X_CONSUMER_SECRET;
  delete process.env.X_ACCESS_TOKEN;
  delete process.env.X_ACCESS_TOKEN_SECRET;
  vi.restoreAllMocks();
});

async function loadAndRun() {
  const { runXReactionCycle } = await import("./x-monitor");
  return runXReactionCycle();
}

describe("runXReactionCycle", () => {
  it("returns zeros when X returns no tweets", async () => {
    vi.stubGlobal("fetch", makeFetch([{ ok: true, body: { data: [] } }]));
    fake.results = [[]]; // CREATE TABLE x_monitored_tweets
    const result = await loadAndRun();
    expect(result.tweetsProcessed).toBe(0);
    expect(result.reactionsCreated).toBe(0);
    expect(result.xRepliesSent).toBe(0);
  });

  it("skips tweets already in x_monitored_tweets", async () => {
    vi.stubGlobal("fetch", makeFetch([{ ok: true, body: TWEET_RESPONSE }]));
    fake.results = [
      [],                         // CREATE TABLE
      [{ tweet_id: "tw-1" }],     // SELECT existing — tweet already processed
    ];
    const result = await loadAndRun();
    expect(result.tweetsProcessed).toBe(0);
    expect(generateXReactionMock).not.toHaveBeenCalled();
  });

  it("creates AIG!itch reaction posts for a new tweet", async () => {
    // Force X_REPLY_CHANCE gate closed so no X reply is attempted
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    vi.stubGlobal("fetch", makeFetch([
      { ok: true, body: TWEET_RESPONSE },
    ]));
    generateXReactionMock.mockResolvedValue({
      content: "lol @elonmusk thinks he's the main character",
      hashtags: ["AIGlitch"],
    });

    fake.results = [
      [],                    // CREATE TABLE
      [],                    // SELECT existing — empty
      [PERSONA_ROW, { ...PERSONA_ROW, id: "persona-b", username: "conspiracy_carl" }], // pick reactors
      [],                    // INSERT post 1
      [],                    // UPDATE ai_personas post_count 1
      [],                    // INSERT post 2
      [],                    // UPDATE ai_personas post_count 2
      [],                    // INSERT x_monitored_tweets
    ];

    const result = await loadAndRun();
    expect(result.tweetsProcessed).toBe(1);
    expect(result.reactionsCreated).toBeGreaterThanOrEqual(1);
    expect(result.xRepliesSent).toBe(0);
    expect(generateXReactionMock).toHaveBeenCalled();
    expect(generateXReplyMock).not.toHaveBeenCalled();
  });

  it("fires an X reply when gate is open and send succeeds", async () => {
    // Math.random returns 0 → reply gate open; idx 0 chosen
    vi.spyOn(Math, "random").mockReturnValue(0);

    vi.stubGlobal("fetch", makeFetch([
      { ok: true, body: TWEET_RESPONSE },                   // fetch tweets
      { ok: true, body: { data: { id: "reply-1" } } },       // POST reply
    ]));
    generateXReactionMock.mockResolvedValue({
      content: "reaction",
      hashtags: ["AIGlitch"],
    });
    generateXReplyMock.mockResolvedValue("nice tweet king");

    fake.results = [
      [],                    // CREATE TABLE
      [],                    // SELECT existing
      [PERSONA_ROW],         // pick reactors (single)
      [],                    // INSERT post
      [],                    // UPDATE post_count
      [],                    // INSERT x_monitored_tweets
    ];

    const result = await loadAndRun();
    expect(result.xRepliesSent).toBe(1);
    expect(generateXReplyMock).toHaveBeenCalledOnce();
  });
});
