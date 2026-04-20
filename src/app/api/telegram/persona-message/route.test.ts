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
}));

const generateMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTelegramMessage: (...args: unknown[]) => generateMock(...args),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthenticated: () => Promise.resolve(mockIsAdmin) }));

const BOT_ROWS = [
  { persona_id: "p-1", bot_token: "tok1", telegram_chat_id: "-100a", display_name: "CH4OS", personality: "snarky", bio: null },
  { persona_id: "p-2", bot_token: "tok2", telegram_chat_id: "-100b", display_name: "VOID", personality: null, bio: "Entropy" },
];

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  sendMessageMock.mockReset();
  generateMock.mockReset();
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "secret";
  vi.resetModules();
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
});

async function callGET(auth?: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/telegram/persona-message", {
    method: "GET",
    headers: auth ? new Headers({ authorization: auth }) : new Headers(),
  }));
}
async function callPOST() {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/telegram/persona-message", { method: "POST" }));
}

describe("GET /api/telegram/persona-message", () => {
  it("401 without auth", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns message when no active bots", async () => {
    fake.results = [[], [], [], []]; // cron CREATE + INSERT + SELECT bots empty + cron UPDATE
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("No active");
  });

  it("sends messages for each active bot", async () => {
    generateMock.mockResolvedValue("Hello from the void!");
    sendMessageMock.mockResolvedValue(undefined);
    fake.results = [[], [], BOT_ROWS, []]; // cron CREATE + INSERT + SELECT + UPDATE
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; errors: number };
    expect(body.sent).toBe(2);
    expect(body.errors).toBe(0);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("counts errors without aborting the run", async () => {
    generateMock.mockRejectedValue(new Error("AI down"));
    fake.results = [[], [], BOT_ROWS, []];
    const res = await callGET("Bearer secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; errors: number };
    expect(body.sent).toBe(0);
    expect(body.errors).toBe(2);
  });

  it("skips bots where generate returns empty string", async () => {
    generateMock.mockResolvedValue("  ");
    sendMessageMock.mockResolvedValue(undefined);
    fake.results = [[], [], BOT_ROWS, []];
    const res = await callGET("Bearer secret");
    const body = (await res.json()) as { sent: number; skipped: number };
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(2);
  });
});

describe("POST /api/telegram/persona-message", () => {
  it("401 when not admin", async () => {
    expect((await callPOST()).status).toBe(401);
  });

  it("200 when admin", async () => {
    mockIsAdmin = true;
    generateMock.mockResolvedValue("hey");
    sendMessageMock.mockResolvedValue(undefined);
    fake.results = [BOT_ROWS];
    expect((await callPOST()).status).toBe(200);
  });
});
