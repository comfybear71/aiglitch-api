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
  return GET(new NextRequest("http://localhost/api/telegram/credit-check", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}
async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/telegram/credit-check", { method: "POST" }));
}

describe("GET /api/telegram/credit-check", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns credit data, no alert when below thresholds", async () => {
    // cron CREATE + cron INSERT + ai_cost_log + sponsors + cron UPDATE
    fake.results = [[], [], [{ total_usd: 1.5 }], [], []];
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total_usd: number; low_balance_count: number; alerted: boolean };
    expect(body.total_usd).toBe(1.5);
    expect(body.low_balance_count).toBe(0);
    expect(body.alerted).toBe(false);
  });

  it("sends alert when AI spend >= threshold and Telegram is configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    process.env.TELEGRAM_CHANNEL_ID = "-100";
    sendMessageMock.mockResolvedValue(undefined);
    fake.results = [[], [], [{ total_usd: 6.0 }], [], []];
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerted: boolean };
    expect(body.alerted).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it("alerted:false when Telegram not configured even with alerts", async () => {
    fake.results = [[], [], [{ total_usd: 10 }], [], []];
    const res = await callGET("Bearer secret");
    const body = (await res.json()) as { alerted: boolean };
    expect(body.alerted).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/telegram/credit-check", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin", async () => {
    mockIsAdmin = true;
    fake.results = [[{ total_usd: 0 }], []];
    expect((await callPOST()).status).toBe(200);
  });
});
