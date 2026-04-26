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

const submitVideoJobMock = vi.fn();
const pollVideoJobMock = vi.fn();
vi.mock("@/lib/ai/xai-extras", () => ({
  submitVideoJob: (...a: unknown[]) => submitVideoJobMock(...a),
  pollVideoJob: (...a: unknown[]) => pollVideoJobMock(...a),
}));

vi.mock("@/lib/ad-campaigns", () => ({
  injectCampaignPlacement: async (p: string) => ({ prompt: p, campaigns: [] }),
}));

vi.mock("@/lib/marketing/platforms", () => ({
  getActiveAccounts: () => Promise.resolve([]),
  postToPlatform: () => Promise.resolve({ success: true }),
}));

vi.mock("@/lib/marketing/content-adapter", () => ({
  adaptContentForPlatform: () =>
    Promise.resolve({
      text: "x",
      hashtags: [],
      callToAction: "x",
      thumbnailPrompt: "x",
    }),
}));

vi.mock("@vercel/blob", () => ({
  put: () => Promise.resolve({ url: "https://blob/x" }),
}));

beforeEach(() => {
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron";
  process.env.XAI_API_KEY = "xai-key";
  submitVideoJobMock.mockReset();
  pollVideoJobMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { __resetMarketingTablesFlag } = await import(
    "@/lib/marketing/ensure-tables"
  );
  __resetMarketingTablesFlag();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/admin/promote-glitchcoin", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

async function callGET(query: string, authHeader?: string) {
  vi.resetModules();
  const { __resetMarketingTablesFlag } = await import(
    "@/lib/marketing/ensure-tables"
  );
  __resetMarketingTablesFlag();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = authHeader
    ? { authorization: authHeader }
    : {};
  return GET(
    new NextRequest(
      `http://localhost/api/admin/promote-glitchcoin${query ? "?" + query : ""}`,
      { headers: new Headers(headers) },
    ),
  );
}

describe("auth", () => {
  it("401 POST without admin or cron auth", async () => {
    expect((await callPOST({})).status).toBe(401);
  });

  it("401 GET without auth", async () => {
    expect((await callGET("")).status).toBe(401);
  });

  it("admin auth lets POST through", async () => {
    mockIsAdmin = true;
    submitVideoJobMock.mockResolvedValue({
      requestId: "req-1",
      videoUrl: null,
      provider: "grok",
      fellBack: false,
    });
    fake.results = [[], []]; // ensure tables
    const res = await callPOST({ mode: "video" });
    expect(res.status).toBe(200);
  });
});

describe("missing XAI_API_KEY", () => {
  it("500 when XAI_API_KEY is unset", async () => {
    mockIsAdmin = true;
    delete process.env.XAI_API_KEY;
    expect((await callPOST({})).status).toBe(500);
  });
});

describe("video mode", () => {
  it("returns submitted phase + requestId for async jobs", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    submitVideoJobMock.mockResolvedValue({
      requestId: "req-123",
      videoUrl: null,
      provider: "grok",
      fellBack: false,
    });

    const res = await callPOST({ mode: "video" });
    const body = (await res.json()) as { phase: string; requestId: string };
    expect(body.phase).toBe("submitted");
    expect(body.requestId).toBe("req-123");
  });

  it("returns done + persisted blob URL for synchronous jobs", async () => {
    mockIsAdmin = true;
    fake.results = [
      [], [], // ensure
      [], // INSERT posts
      [], // UPDATE persona
    ];
    submitVideoJobMock.mockResolvedValue({
      requestId: null,
      videoUrl: "https://xai/video.mp4",
      provider: "grok",
      fellBack: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }),
    );

    const res = await callPOST({ mode: "video" });
    const body = (await res.json()) as { phase: string; videoUrl: string };
    expect(body.phase).toBe("done");
    expect(body.videoUrl).toBe("https://blob/x");
  });

  it("returns failure when submitVideoJob has no requestId or URL", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    submitVideoJobMock.mockResolvedValue({
      requestId: null,
      videoUrl: null,
      provider: "none",
      fellBack: false,
      error: "tier required",
    });
    const res = await callPOST({ mode: "video" });
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("tier");
  });
});

describe("GET poll + preview", () => {
  it("preview_prompt returns image prompt for mode=image", async () => {
    mockIsAdmin = true;
    const res = await callGET("action=preview_prompt&mode=image");
    const body = (await res.json()) as { ok: boolean; prompt: string; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("image");
    expect(body.prompt.length).toBeGreaterThan(20);
  });

  it("400 when ?id is missing on poll path", async () => {
    mockIsAdmin = true;
    expect((await callGET("")).status).toBe(400);
  });

  it("returns pending while video gen is still running", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    pollVideoJobMock.mockResolvedValue({ status: "pending" });
    const res = await callGET("id=req-1");
    const body = (await res.json()) as { phase: string };
    expect(body.phase).toBe("poll");
  });

  it("persists video on done + spreads to socials", async () => {
    mockIsAdmin = true;
    fake.results = [
      [], [], // ensure
      [], // INSERT posts
      [], // UPDATE persona
    ];
    pollVideoJobMock.mockResolvedValue({
      status: "done",
      videoUrl: "https://xai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }),
    );
    const res = await callGET("id=req-1");
    const body = (await res.json()) as { phase: string; videoUrl: string };
    expect(body.phase).toBe("done");
    expect(body.videoUrl).toBe("https://blob/x");
  });

  it("returns failed status when xAI marks job failed", async () => {
    mockIsAdmin = true;
    fake.results = [[], []];
    pollVideoJobMock.mockResolvedValue({ status: "failed", error: "moderation" });
    const res = await callGET("id=req-1");
    const body = (await res.json()) as { phase: string; success: boolean };
    expect(body.phase).toBe("done");
    expect(body.success).toBe(false);
  });
});
