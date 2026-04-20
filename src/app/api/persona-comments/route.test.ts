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

const generateMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generatePersonaComment: (...args: unknown[]) => generateMock(...args),
}));

const campaignsMock = vi.fn();
vi.mock("@/lib/ad-campaigns", () => ({
  getActiveCampaigns: () => campaignsMock(),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const PERSONA_A = {
  id: "p-a", username: "alpha", display_name: "Alpha", personality: "chaotic",
  persona_type: "chaos", bio: "bio",
};
const PERSONA_B = {
  id: "p-b", username: "beta", display_name: "Beta", personality: "calm",
  persona_type: "zen", bio: "bio",
};
const POST_BY_B = {
  id: "post-1", content: "a longer than twenty char post content right here",
  persona_id: "p-b", media_type: null,
  author_name: "Beta", author_username: "beta",
};

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  generateMock.mockReset();
  campaignsMock.mockReset();
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "secret";
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function callGET(auth?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/persona-comments", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}

async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/persona-comments", { method: "POST" }));
}

describe("GET /api/persona-comments — auth", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });
  it("401 with wrong token", async () => {
    expect((await callGET("Bearer wrong")).status).toBe(401);
  });
});

describe("GET /api/persona-comments — happy path", () => {
  it("returns zero comments when no active personas", async () => {
    campaignsMock.mockResolvedValue([]);
    fake.results = [
      [],   // CREATE cron_runs
      [],   // INSERT cron_runs
      [],   // SELECT personas — empty
      [],   // UPDATE cron_runs ok
    ];
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: number; results: unknown[] };
    expect(body.comments).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("returns zero comments when no recent posts exist", async () => {
    campaignsMock.mockResolvedValue([]);
    fake.results = [
      [],                              // CREATE cron_runs
      [],                              // INSERT cron_runs
      [PERSONA_A],                     // SELECT personas
      [],                              // SELECT recent posts — empty
      [],                              // UPDATE cron_runs ok
    ];
    const res = await callGET("Bearer secret");
    const body = (await res.json()) as { comments: number };
    expect(body.comments).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("generates a comment and inserts reply + bumps comment_count", async () => {
    // Force sponsor gate closed so no sponsor branch
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    campaignsMock.mockResolvedValue([]);
    generateMock.mockResolvedValue("nice take, king");

    fake.results = [
      [],                   // CREATE cron_runs
      [],                   // INSERT cron_runs
      [PERSONA_A],          // SELECT personas (just one, so single loop iter)
      [POST_BY_B],          // SELECT recent posts
      [],                   // INSERT posts (reply)
      [],                   // UPDATE posts comment_count
      [],                   // UPDATE cron_runs ok
    ];

    const resPromise = callGET("Bearer secret");
    await vi.runAllTimersAsync();
    const res = await resPromise;

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: number;
      results: { persona: string; postId: string; comment: string; sponsor?: string }[];
    };
    expect(body.comments).toBe(1);
    expect(body.results[0]).toMatchObject({ persona: "Alpha", postId: "post-1", comment: "nice take, king" });
    expect(body.results[0].sponsor).toBeUndefined();
  });

  it("skips posts authored by the commenting persona", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    campaignsMock.mockResolvedValue([]);

    fake.results = [
      [],                                               // CREATE cron_runs
      [],                                               // INSERT cron_runs
      [PERSONA_B],                                      // SELECT personas (B)
      [POST_BY_B],                                      // SELECT posts — only B's own post
      [],                                               // UPDATE cron_runs ok
    ];

    const res = await callGET("Bearer secret");
    const body = (await res.json()) as { comments: number };
    expect(body.comments).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("passes sponsor into generator when gate opens", async () => {
    // Math.random sequence: 0=sponsor-gate open, 0=pick first sponsor, ...
    vi.spyOn(Math, "random").mockReturnValue(0);
    campaignsMock.mockResolvedValue([
      { brand_name: "Acme", product_name: "WidgetX" },
    ]);
    generateMock.mockResolvedValue("love it powered by acme");

    fake.results = [
      [],                  // CREATE cron_runs
      [],                  // INSERT cron_runs
      [PERSONA_A],         // SELECT personas
      [POST_BY_B],         // SELECT recent posts
      [],                  // INSERT reply
      [],                  // UPDATE comment_count
      [],                  // UPDATE cron_runs ok
    ];

    const resPromise = callGET("Bearer secret");
    await vi.runAllTimersAsync();
    const res = await resPromise;

    const body = (await res.json()) as { results: { sponsor?: string }[] };
    expect(body.results[0].sponsor).toBe("Acme");
    expect(generateMock).toHaveBeenCalled();
    const callArg = generateMock.mock.calls[0][0] as { sponsor?: { brandName: string } };
    expect(callArg.sponsor?.brandName).toBe("Acme");
  });
});

describe("POST /api/persona-comments — auth", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin and no personas", async () => {
    mockIsAdmin = true;
    campaignsMock.mockResolvedValue([]);
    fake.results = [[]];  // SELECT personas — empty
    const res = await callPOST();
    expect(res.status).toBe(200);
  });
});
