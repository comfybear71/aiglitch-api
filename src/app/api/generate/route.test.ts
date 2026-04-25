import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake: { calls: SqlCall[]; results: RowSet[] } = { calls: [], results: [] };

function fakeSql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const generatePostMock = vi.fn();
const generateCommentMock = vi.fn();
const generateBeefMock = vi.fn();
const generateCollabMock = vi.fn();
const generateChallengeMock = vi.fn();

vi.mock("@/lib/content/ai-engine", () => ({
  generatePost: (...args: unknown[]) => generatePostMock(...args),
  generateComment: (...args: unknown[]) => generateCommentMock(...args),
  generateBeefPost: (...args: unknown[]) => generateBeefMock(...args),
  generateCollabPost: (...args: unknown[]) => generateCollabMock(...args),
  generateChallengePost: (...args: unknown[]) => generateChallengeMock(...args),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const PERSONA_A = {
  id: "p-a",
  username: "alpha",
  display_name: "Alpha",
  avatar_emoji: "🚀",
  personality: "chaos agent",
  bio: "x",
  persona_type: "chaos",
  human_backstory: "",
  follower_count: 0,
  post_count: 0,
  created_at: "2026-04-22T00:00:00Z",
  is_active: 1,
  activity_level: 3,
};
const PERSONA_B = { ...PERSONA_A, id: "p-b", username: "beta", display_name: "Beta" };
const PERSONA_C = { ...PERSONA_A, id: "p-c", username: "gamma", display_name: "Gamma" };

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron-secret";

  generatePostMock.mockReset();
  generateCommentMock.mockReset();
  generateBeefMock.mockReset();
  generateCollabMock.mockReset();
  generateChallengeMock.mockReset();

  // Default — return a regular post + comment so any path produces
  // something coherent without per-test setup.
  generatePostMock.mockResolvedValue({
    content: "regular post",
    hashtags: ["AIGlitch"],
    post_type: "text",
  });
  generateCommentMock.mockResolvedValue({ content: "interesting" });
  generateBeefMock.mockResolvedValue({
    content: "@beta come at me",
    hashtags: ["AIBeef"],
    post_type: "hot_take",
  });
  generateCollabMock.mockResolvedValue({
    content: "@beta lets collab",
    hashtags: ["AICollab"],
    post_type: "text",
  });
  generateChallengeMock.mockResolvedValue({
    content: "my take",
    hashtags: ["GlitchChallenge"],
    post_type: "text",
  });

  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function callGET(authHeader?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = authHeader
    ? { authorization: authHeader }
    : {};
  return GET(
    new NextRequest("http://localhost/api/generate", {
      headers: new Headers(headers),
    }),
  );
}

async function callPOST(opts?: { authHeader?: string }) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = opts?.authHeader
    ? { authorization: opts.authHeader }
    : {};
  return POST(
    new NextRequest("http://localhost/api/generate", {
      method: "POST",
      headers: new Headers(headers),
    }),
  );
}

// Force "normal" mode by holding the special-mode roll above 0.45.
function forceNormalMode() {
  // pickSpecialMode rolls Math.random() once; reactors roll later.
  // Stub to a sequence: first call → 0.99 (normal), rest → 0.99 (skip
  // reactors so we don't drown in extra DB calls).
  vi.spyOn(Math, "random").mockReturnValue(0.99);
}

describe("GET /api/generate — auth", () => {
  it("401 when no Authorization header", async () => {
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("401 when Bearer token is wrong", async () => {
    const res = await callGET("Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("admin cookie auth path also lets the request through", async () => {
    forceNormalMode();
    mockIsAdmin = true;
    fake.results = [
      [], // CREATE TABLE cron_runs
      [], // INSERT cron_runs
      [PERSONA_A, PERSONA_B], // SELECT personas (2)
      [], // recent posts
      [], // daily topics
      [], // INSERT post (regular A)
      [], // UPDATE persona post_count
      [], // SELECT reactors
      [], // INSERT post (regular B)
      [], // UPDATE persona post_count
      [], // SELECT reactors
      [], // UPDATE cron_runs (success)
    ];

    const res = await callGET();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/generate — happy path", () => {
  it("normal mode with two personas generates two regular posts", async () => {
    forceNormalMode();
    fake.results = [
      [], // ensure cron_runs
      [], // INSERT cron_runs
      [PERSONA_A, PERSONA_B], // SELECT personas
      [], // recent posts
      [], // daily topics
      [], // INSERT post for A
      [], // UPDATE post_count A
      [], // SELECT reactors A — empty (no reactions)
      [], // INSERT post for B
      [], // UPDATE post_count B
      [], // SELECT reactors B — empty
      [], // UPDATE cron_runs done
    ];

    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      generated: number;
      attempted: number;
      special_mode: string;
      _cron_run_id: string;
    };
    expect(body.attempted).toBe(2);
    expect(body.generated).toBe(2);
    expect(body.special_mode).toBe("normal");
    expect(typeof body._cron_run_id).toBe("string");
    expect(generatePostMock).toHaveBeenCalledTimes(2);
  });
});

describe("special mode dispatch", () => {
  it("beef mode runs both directions and creates a beef thread", async () => {
    // Math.random sequence: index 0 is personaCount roll, index 1 is the
    // specialMode roll. Put 0.10 at index 1 to land in the beef branch
    // (specialRoll < 0.20). 0.99 elsewhere skips reactors.
    let call = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      const seq = [0.99, 0.10, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99];
      const v = seq[call] ?? 0.99;
      call++;
      return v;
    });

    fake.results = [
      [], // CREATE cron_runs
      [], // INSERT cron_runs
      [PERSONA_A, PERSONA_B], // SELECT personas
      [], // recent posts
      [], // daily topics
      [], // INSERT ai_beef_threads
      [], // INSERT post (beef A)
      [], // UPDATE post_count A
      [], // SELECT reactors A
      [], // INSERT post (beef B)
      [], // UPDATE post_count B
      [], // SELECT reactors B
      [], // UPDATE ai_beef_threads
      [], // UPDATE cron_runs done
    ];

    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { special_mode: string; generated: number };
    expect(body.special_mode).toBe("beef");
    expect(body.generated).toBe(2);
    expect(generateBeefMock).toHaveBeenCalledTimes(2);

    // Each beef call should target the OTHER persona
    const firstCall = generateBeefMock.mock.calls[0];
    const secondCall = generateBeefMock.mock.calls[1];
    expect(firstCall[0]).toBe(PERSONA_A);
    expect(firstCall[1]).toBe(PERSONA_B);
    expect(secondCall[0]).toBe(PERSONA_B);
    expect(secondCall[1]).toBe(PERSONA_A);
  });

  it("collab mode generates one post tagging persona B", async () => {
    // index 0 = personaCount, index 1 = specialMode (0.25 → collab band)
    let call = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      const seq = [0.99, 0.25, 0.99, 0.99, 0.99];
      const v = seq[call] ?? 0.99;
      call++;
      return v;
    });

    fake.results = [
      [], // ensure cron_runs
      [], // INSERT cron_runs
      [PERSONA_A, PERSONA_B], // SELECT personas
      [], // recent posts
      [], // daily topics
      [], // INSERT post (collab)
      [], // UPDATE post_count
      [], // SELECT reactors
      [], // UPDATE cron_runs
    ];

    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { special_mode: string };
    expect(body.special_mode).toBe("collab");
    expect(generateCollabMock).toHaveBeenCalledTimes(1);
  });

  it("challenge mode runs all selected personas", async () => {
    // index 0 = personaCount, index 1 = specialMode (0.40 → challenge band)
    let call = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      const seq = [0.99, 0.40, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99];
      const v = seq[call] ?? 0.99;
      call++;
      return v;
    });

    fake.results = [
      [], // ensure cron_runs
      [], // INSERT cron_runs
      [PERSONA_A, PERSONA_B, PERSONA_C], // 3 personas
      [], // recent posts
      [], // daily topics
      [], // INSERT ai_challenges
      [], // INSERT post (challenge A)
      [], // UPDATE post_count A
      [], // SELECT reactors A
      [], // INSERT post (challenge B)
      [], // UPDATE post_count B
      [], // SELECT reactors B
      [], // INSERT post (challenge C)
      [], // UPDATE post_count C
      [], // SELECT reactors C
      [], // UPDATE cron_runs
    ];

    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { special_mode: string; generated: number };
    expect(body.special_mode).toBe("challenge");
    expect(generateChallengeMock).toHaveBeenCalledTimes(3);
  });
});

describe("error handling", () => {
  it("a single persona's post failure does not abort the run", async () => {
    forceNormalMode();
    generatePostMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        content: "the survivor",
        hashtags: ["AIGlitch"],
        post_type: "text",
      });

    fake.results = [
      [], [], [PERSONA_A, PERSONA_B], [], [], // no insert for A (failed)
      [], // INSERT post B
      [], // UPDATE post_count B
      [], // SELECT reactors B
      [], // UPDATE cron_runs
    ];

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generated: number; attempted: number };
    expect(body.attempted).toBe(2);
    expect(body.generated).toBe(1);
    errSpy.mockRestore();
  });
});

describe("POST /api/generate — admin manual trigger", () => {
  it("401 when no auth", async () => {
    const res = await callPOST();
    expect(res.status).toBe(401);
  });

  it("admin cookie path runs without writing to cron_runs", async () => {
    forceNormalMode();
    mockIsAdmin = true;
    fake.results = [
      [PERSONA_A], // SELECT personas (1)
      [], // recent posts
      [], // daily topics
      [], // INSERT post
      [], // UPDATE post_count
      [], // SELECT reactors
    ];

    const res = await callPOST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generated: number;
      _cron_run_id?: string;
    };
    expect(body.generated).toBe(1);
    expect(body._cron_run_id).toBeUndefined();
  });
});
