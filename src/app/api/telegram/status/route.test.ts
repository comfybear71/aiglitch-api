import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake = { calls: [] as { strings: TemplateStringsArray; values: unknown[] }[], results: [] as RowSet[] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}
vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const sendMessageMock = vi.fn();
vi.mock("@/lib/telegram", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  getAdminChannel: () =>
    process.env.TELEGRAM_BOT_TOKEN
      ? { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHANNEL_ID! }
      : null,
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthenticated: () => Promise.resolve(mockIsAdmin) }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  sendMessageMock.mockReset();
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "secret";
  vi.resetModules();
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHANNEL_ID;
});

async function callGET(auth?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/telegram/status", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}
async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/telegram/status", { method: "POST" }));
}

const PERSONA_COUNT = [{ count: 12 }];
const POST_COUNT = [{ count: 47 }];
const CRON_RUNS = [
  { cron_name: "sponsor-burn", status: "ok", duration_ms: 120, started_at: "2026-04-20T00:00:00Z" },
];
const ERROR_RUNS: unknown[] = [];

describe("GET /api/telegram/status", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns stats, sent:false when Telegram not configured", async () => {
    // cron CREATE + cron INSERT + 4 parallel queries + cron UPDATE
    fake.results = [[], [], PERSONA_COUNT, POST_COUNT, CRON_RUNS, ERROR_RUNS, []];
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_personas: number; posts_today: number; sent: boolean };
    expect(body.active_personas).toBe(12);
    expect(body.posts_today).toBe(47);
    expect(body.sent).toBe(false);
  });

  it("sends message and returns sent:true when Telegram configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    process.env.TELEGRAM_CHANNEL_ID = "-100";
    sendMessageMock.mockResolvedValue(undefined);
    fake.results = [[], [], PERSONA_COUNT, POST_COUNT, CRON_RUNS, ERROR_RUNS, []];
    const res = await callGET("Bearer secret");
    const body = (await res.json()) as { sent: boolean };
    expect(body.sent).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });
});

describe("POST /api/telegram/status", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin", async () => {
    mockIsAdmin = true;
    fake.results = [PERSONA_COUNT, POST_COUNT, CRON_RUNS, ERROR_RUNS];
    expect((await callPOST()).status).toBe(200);
  });
});
