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

const generateDailyTopicsMock = vi.fn();
const generateBreakingNewsMock = vi.fn();
vi.mock("@/lib/content/topic-engine", () => ({
  generateDailyTopics: () => generateDailyTopicsMock(),
  generateBreakingNewsPost: (...args: unknown[]) => generateBreakingNewsMock(...args),
  pickBreakingNewsAngle: (i: number) => `angle-${i}`,
}));

const generatePostMock = vi.fn();
const generateCommentMock = vi.fn();
vi.mock("@/lib/content/ai-engine", () => ({
  generatePost: (...args: unknown[]) => generatePostMock(...args),
  generateComment: (...args: unknown[]) => generateCommentMock(...args),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  generateDailyTopicsMock.mockReset();
  generateBreakingNewsMock.mockReset();
  generatePostMock.mockReset();
  generateCommentMock.mockReset();
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

async function callGET(auth?: string, query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/generate-topics${query}`, {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}

async function callPOST(query = "") {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest(`http://localhost/api/generate-topics${query}`, { method: "POST" }));
}

describe("GET /api/generate-topics — auth", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });
  it("401 with wrong token", async () => {
    expect((await callGET("Bearer wrong")).status).toBe(401);
  });
});

describe("GET /api/generate-topics — topic generation", () => {
  it("generates fresh topics when active count < 5", async () => {
    generateDailyTopicsMock.mockResolvedValue([
      { headline: "t1", summary: "s1", original_theme: "theme", anagram_mappings: "m", mood: "amused", category: "tech" },
    ]);

    fake.results = [
      [],                       // CREATE cron_runs
      [],                       // INSERT cron_runs
      [],                       // UPDATE expire old
      [{ count: 2 }],           // SELECT active count
      [],                       // SELECT existing topics
      [],                       // INSERT daily_topics
      [],                       // SELECT news bot — empty
      [],                       // SELECT reaction personas — empty (so no reactions)
      [],                       // UPDATE cron_runs ok
    ];

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generated: number; inserted: number };
    expect(body.generated).toBe(1);
    expect(body.inserted).toBe(1);
    expect(generateDailyTopicsMock).toHaveBeenCalled();
  });

  it("skips generation when active count >= 5 and not forced", async () => {
    fake.results = [
      [],                       // CREATE cron_runs
      [],                       // INSERT cron_runs
      [],                       // UPDATE expire old
      [{ count: 7 }],           // SELECT active count
      [                         // SELECT existing topics
        { headline: "existing", summary: "s", mood: "amused", category: "tech" },
      ],
      [],                       // SELECT news bot — empty
      [],                       // SELECT reaction personas — empty
      [],                       // UPDATE cron_runs ok
    ];

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    expect(generateDailyTopicsMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { generated: number; topics: { headline: string }[] };
    expect(body.generated).toBe(0);
    expect(body.topics[0].headline).toBe("existing");
  });

  it("force=true triggers generation even when count >= 5", async () => {
    generateDailyTopicsMock.mockResolvedValue([]);
    fake.results = [
      [], [],                   // cron_runs setup
      [],                       // expire
      [{ count: 10 }],          // count
      [                         // existing
        { headline: "e", summary: "s", mood: "amused", category: "tech" },
      ],
      [],                       // news bot
      [],                       // reaction personas
      [],                       // cron_runs ok
    ];

    await callGET("Bearer secret", "?force=true");
    expect(generateDailyTopicsMock).toHaveBeenCalled();
  });
});

describe("GET /api/generate-topics — breaking news + reactions", () => {
  it("posts breaking news blurb when @news_feed_ai exists", async () => {
    generateBreakingNewsMock.mockResolvedValue({
      content: "breaking take",
      hashtags: ["AIGlitchBreaking"],
      post_type: "news",
    });

    const TOPIC = { headline: "Story", summary: "stuff", mood: "amused", category: "world" };
    const NEWS_BOT = { id: "p-news", username: "news_feed_ai", display_name: "News", personality: "p", bio: "b", persona_type: "news", human_backstory: "", avatar_emoji: "📰", follower_count: 0, post_count: 0, created_at: "", is_active: 1, activity_level: 1 };

    fake.results = [
      [], [],                   // cron_runs
      [],                       // expire
      [{ count: 9 }],           // count (skip generation)
      [TOPIC],                  // existing
      [NEWS_BOT],               // SELECT news bot
      [],                       // INSERT news post
      [],                       // UPDATE news_feed_ai post_count
      [],                       // SELECT reaction personas — empty
      [],                       // cron_runs ok
    ];

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text_news_posts: number };
    expect(body.text_news_posts).toBe(1);
    expect(generateBreakingNewsMock).toHaveBeenCalled();
  });

  it("skips breaking news when no briefing topics exist", async () => {
    fake.results = [
      [], [],                   // cron_runs
      [],                       // expire
      [{ count: 0 }],           // count
      [],                       // existing — empty
      [],                       // daily_topics insert paths skipped (generateDailyTopics returns [])
      [],                       // SELECT reaction personas — empty
      [],                       // cron_runs ok
    ];
    generateDailyTopicsMock.mockResolvedValue([]);

    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    expect(generateBreakingNewsMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-topics — auth", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin", async () => {
    mockIsAdmin = true;
    generateDailyTopicsMock.mockResolvedValue([]);
    fake.results = [
      [],                       // expire
      [{ count: 0 }],           // count
      [],                       // existing
      [],                       // reaction personas
    ];
    const res = await callPOST();
    expect(res.status).toBe(200);
  });
});
