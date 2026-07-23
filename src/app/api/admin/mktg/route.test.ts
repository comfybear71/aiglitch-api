import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { marketingEnsureSqlStubs } from "@/lib/marketing/ensure-tables";

type RowSet = unknown[];
const fake: { results: RowSet[] } = { results: [] };
function fakeSql(strings: TemplateStringsArray): Promise<RowSet> {
  void strings;
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const getMarketingStatsMock = vi.fn();
const runMarketingCycleMock = vi.fn();
const collectAllMetricsMock = vi.fn();
vi.mock("@/lib/marketing", () => ({
  getMarketingStats: () => getMarketingStatsMock(),
  runMarketingCycle: () => runMarketingCycleMock(),
  collectAllMetrics: () => collectAllMetricsMock(),
}));

const testPlatformTokenMock = vi.fn();
const getAnyAccountForPlatformMock = vi.fn();
const postToPlatformMock = vi.fn();
const getActiveAccountsMock = vi.fn();
vi.mock("@/lib/marketing/platforms", () => ({
  testPlatformToken: (...a: unknown[]) => testPlatformTokenMock(...a),
  getAnyAccountForPlatform: (...a: unknown[]) =>
    getAnyAccountForPlatformMock(...a),
  postToPlatform: (...a: unknown[]) => postToPlatformMock(...a),
  getActiveAccounts: (...a: unknown[]) => getActiveAccountsMock(...a),
}));

// Hero/poster generators hit xAI — mock them so the route's handler
// logic is tested without real image generation.
const generateHeroImageMock = vi.fn();
const generatePosterMock = vi.fn();
const previewHeroPromptMock = vi.fn();
const previewPosterPromptMock = vi.fn();
vi.mock("@/lib/marketing/hero-image", () => ({
  generateHeroImage: (...a: unknown[]) => generateHeroImageMock(...a),
  generatePoster: (...a: unknown[]) => generatePosterMock(...a),
  previewHeroPrompt: (...a: unknown[]) => previewHeroPromptMock(...a),
  previewPosterPrompt: (...a: unknown[]) => previewPosterPromptMock(...a),
}));

vi.mock("@/lib/marketing/content-adapter", () => ({
  adaptContentForPlatform: vi.fn().mockResolvedValue({ text: "adapted" }),
}));

vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => void | Promise<void>) => {
      void fn();
    },
  };
});

beforeEach(() => {
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  getMarketingStatsMock.mockReset();
  runMarketingCycleMock.mockReset();
  collectAllMetricsMock.mockReset();
  testPlatformTokenMock.mockReset();
  getAnyAccountForPlatformMock.mockReset();
  postToPlatformMock.mockReset();
  getActiveAccountsMock.mockReset();
  getActiveAccountsMock.mockResolvedValue([]);
  generateHeroImageMock.mockReset();
  generatePosterMock.mockReset();
  previewHeroPromptMock.mockReset();
  previewPosterPromptMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callGET(query = "") {
  vi.resetModules();
  const { __resetMarketingTablesFlag } = await import(
    "@/lib/marketing/ensure-tables"
  );
  __resetMarketingTablesFlag();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(
    new NextRequest(`http://localhost/api/admin/mktg${query ? "?" + query : ""}`),
  );
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { __resetMarketingTablesFlag } = await import(
    "@/lib/marketing/ensure-tables"
  );
  __resetMarketingTablesFlag();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/admin/mktg", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

describe("auth", () => {
  it("401 GET when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });
  it("401 POST when not admin", async () => {
    expect((await callPOST({})).status).toBe(401);
  });
});

describe("GET actions", () => {
  it("default action 'stats' returns getMarketingStats payload", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()]; // ensure tables
    getMarketingStatsMock.mockResolvedValue({ totalPosted: 5 });
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalPosted: number };
    expect(body.totalPosted).toBe(5);
  });

  it("test_token returns 400 without ?platform=", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    expect((await callGET("action=test_token")).status).toBe(400);
  });

  it("test_token forwards platform to testPlatformToken", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    testPlatformTokenMock.mockResolvedValue({ ok: true });
    const res = await callGET("action=test_token&platform=x");
    expect(res.status).toBe(200);
    expect(testPlatformTokenMock).toHaveBeenCalledWith("x");
  });

  it("preview_hero_prompt returns 200 with prompt", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    previewHeroPromptMock.mockResolvedValue("HERO PROMPT TEXT");
    const res = await callGET("action=preview_hero_prompt");
    expect(res.status).toBe(200);
    expect((await res.json()).prompt).toBe("HERO PROMPT TEXT");
  });

  it("unknown action returns 400", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    expect((await callGET("action=does-not-exist")).status).toBe(400);
  });
});

describe("POST actions", () => {
  it("missing action returns 400", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    expect((await callPOST({})).status).toBe(400);
  });

  it("run_cycle delegates to runMarketingCycle", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    runMarketingCycleMock.mockResolvedValue({
      posted: 1,
      failed: 0,
      skipped: 0,
      details: [],
    });
    const res = await callPOST({ action: "run_cycle" });
    const body = (await res.json()) as { posted: number };
    expect(body.posted).toBe(1);
  });

  it("create_campaign INSERTs and returns the new id", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs(), []]; // ensure + INSERT
    const res = await callPOST({ action: "create_campaign", name: "Test" });
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("save_account inserts when none exists, updates when one does", async () => {
    mockIsAdmin = true;
    // First call: no existing → INSERT path
    fake.results = [...marketingEnsureSqlStubs(), [], []]; // ensure + SELECT existing (empty) + INSERT
    let res = await callPOST({
      action: "save_account",
      platform: "x",
      account_name: "test",
    });
    expect(res.status).toBe(200);

    // Second call: existing → UPDATE path
    fake.results = [...marketingEnsureSqlStubs(), [{ id: "acc-1" }], []];
    res = await callPOST({
      action: "save_account",
      platform: "x",
      account_name: "renamed",
    });
    expect(res.status).toBe(200);
  });

  it("test_post 404 when no account configured", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    getAnyAccountForPlatformMock.mockResolvedValue(null);
    const res = await callPOST({ action: "test_post", platform: "x" });
    expect(res.status).toBe(404);
  });

  it("test_post forwards to postToPlatform when account exists", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    getAnyAccountForPlatformMock.mockResolvedValue({
      id: "a",
      platform: "x",
      account_name: "x",
    });
    postToPlatformMock.mockResolvedValue({ success: true });
    const res = await callPOST({ action: "test_post", platform: "x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("delete_post 400 without id, 200 with id", async () => {
    mockIsAdmin = true;
    fake.results = [...marketingEnsureSqlStubs()];
    expect((await callPOST({ action: "delete_post" })).status).toBe(400);

    fake.results = [...marketingEnsureSqlStubs(), []]; // ensure + DELETE
    expect(
      (await callPOST({ action: "delete_post", id: "p1" })).status,
    ).toBe(200);
  });

  it("generate_hero returns 200 with url + spreadResults", async () => {
    mockIsAdmin = true;
    generateHeroImageMock.mockResolvedValue({ url: "https://blob/hero.jpg" });
    getActiveAccountsMock.mockResolvedValue([]);
    // ensure + settings UPSERT + posts INSERT + persona UPDATE
    fake.results = [...marketingEnsureSqlStubs(), [], [], []];
    const res = await callPOST({ action: "generate_hero" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://blob/hero.jpg");
    expect(Array.isArray(body.spreadResults)).toBe(true);
    expect(generateHeroImageMock).toHaveBeenCalled();
  });

  it("generate_poster returns 200 with url, passes focus_topics through", async () => {
    mockIsAdmin = true;
    generatePosterMock.mockResolvedValue({ url: "https://blob/poster.jpg" });
    getActiveAccountsMock.mockResolvedValue([]);
    fake.results = [...marketingEnsureSqlStubs(), [], [], []];
    const res = await callPOST({
      action: "generate_poster",
      focus_topics: JSON.stringify(["channels"]),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://blob/poster.jpg");
    expect(generatePosterMock).toHaveBeenCalledWith(["channels"], undefined);
  });

  it("generate_hero returns 502 when generator yields no url", async () => {
    mockIsAdmin = true;
    generateHeroImageMock.mockResolvedValue({ url: null, error: "xAI down" });
    fake.results = [...marketingEnsureSqlStubs()]; // ensure only
    const res = await callPOST({ action: "generate_hero" });
    expect(res.status).toBe(502);
  });
});
