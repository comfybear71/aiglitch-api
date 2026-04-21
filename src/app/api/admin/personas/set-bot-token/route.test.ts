import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

type CommandsResult = { ok: boolean; error?: string };
const commands = {
  calls: [] as string[],
  result: { ok: true } as CommandsResult,
};

vi.mock("@/lib/telegram/commands", () => ({
  registerTelegramCommands: (botToken: string) => {
    commands.calls.push(botToken);
    return Promise.resolve(commands.result);
  },
}));

type FetchCall = { url: string; body?: unknown };
const fetchCalls: FetchCall[] = [];
let fetchQueue: Array<{ ok: boolean; description?: string; result?: { username?: string } } | Error> = [];

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  commands.calls = [];
  commands.result = { ok: true };
  fetchCalls.length = 0;
  fetchQueue = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.NEXT_PUBLIC_APP_URL = "https://api.aiglitch.app";
  vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    fetchCalls.push({ url: String(url), body });
    const next = fetchQueue.shift();
    if (!next) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  vi.restoreAllMocks();
});

async function call(body?: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "POST",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(
    "http://localhost/api/admin/personas/set-bot-token",
    init,
  );
  return mod.POST(req);
}

const persona = {
  id: "p-1",
  username: "stella",
  display_name: "Stella",
};

describe("POST /api/admin/personas/set-bot-token", () => {
  it("401 when not admin", async () => {
    expect((await call({}, false)).status).toBe(401);
  });

  it("400 when persona_id missing", async () => {
    fake.results.push([]); // CREATE TABLE
    const res = await call({});
    expect(res.status).toBe(400);
  });

  it("404 when persona not found", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([]); // persona lookup empty
    const res = await call({ persona_id: "missing", bot_token: "t" });
    expect(res.status).toBe(404);
  });

  it("deactivate mode (no bot_token) flips is_active false", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]); // persona lookup
    fake.results.push([]); // UPDATE
    const res = await call({ persona_id: "p-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; action: string };
    expect(body.success).toBe(true);
    expect(body.action).toBe("deactivated");
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE persona_telegram_bots"),
    );
    expect(update).toBeDefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it("deactivate mode with empty string behaves the same", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]);
    fake.results.push([]); // UPDATE
    const res = await call({ persona_id: "p-1", bot_token: "   " });
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("deactivated");
  });

  it("invalid bot token (getMe ok:false) → 400 before DB writes", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]);
    fetchQueue.push({ ok: false, description: "Not Found" });
    const res = await call({ persona_id: "p-1", bot_token: "bad-token" });
    expect(res.status).toBe(400);
    // No DELETE / INSERT landed
    const delCall = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM persona_telegram_bots"),
    );
    expect(delCall).toBeUndefined();
  });

  it("getMe network exception → 502", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]);
    fetchQueue.push(new Error("network down"));
    const res = await call({ persona_id: "p-1", bot_token: "token-x" });
    expect(res.status).toBe(502);
  });

  it("happy path — getMe ok, webhook ok, commands ok → INSERT + full response", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]); // persona lookup
    fetchQueue.push({ ok: true, result: { username: "stella_bot" } }); // getMe
    fetchQueue.push({ ok: true }); // setWebhook
    fake.results.push([]); // DELETE
    fake.results.push([]); // INSERT
    const res = await call({ persona_id: "p-1", bot_token: "token-x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      action: string;
      bot_username: string;
      webhook_set: boolean;
      commands_set: boolean;
    };
    expect(body.action).toBe("set");
    expect(body.bot_username).toBe("stella_bot");
    expect(body.webhook_set).toBe(true);
    expect(body.commands_set).toBe(true);

    const webhookCall = fetchCalls.find((c) => c.url.includes("setWebhook"));
    expect(webhookCall).toBeDefined();
    expect((webhookCall!.body as { url: string }).url).toBe(
      "https://api.aiglitch.app/api/telegram/persona-chat/p-1",
    );
    expect((webhookCall!.body as { allowed_updates: string[] }).allowed_updates).toEqual([
      "message",
      "message_reaction",
    ]);
    expect(commands.calls).toEqual(["token-x"]);

    // DELETE came before INSERT
    const deleteIdx = fake.calls.findIndex((c) =>
      c.strings.join("?").includes("DELETE FROM persona_telegram_bots"),
    );
    const insertIdx = fake.calls.findIndex((c) =>
      c.strings.join("?").includes("INSERT INTO persona_telegram_bots"),
    );
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
  });

  it("webhook setWebhook fails but DB INSERT still runs (non-fatal)", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]);
    fetchQueue.push({ ok: true, result: { username: "s_bot" } }); // getMe
    fetchQueue.push({ ok: false, description: "chat not found" }); // setWebhook
    fake.results.push([]); // DELETE
    fake.results.push([]); // INSERT
    const res = await call({ persona_id: "p-1", bot_token: "tok" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      webhook_set: boolean;
      webhook_error: string;
      message: string;
    };
    expect(body.webhook_set).toBe(false);
    expect(body.webhook_error).toBe("chat not found");
    expect(body.message).toContain("webhook failed");
    // INSERT still landed
    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO persona_telegram_bots"),
    );
    expect(insertCall).toBeDefined();
  });

  it("commands registration failure captured in response", async () => {
    commands.result = { ok: false, error: "setMyCommands rate limited" };
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]);
    fetchQueue.push({ ok: true, result: { username: "s_bot" } });
    fetchQueue.push({ ok: true });
    fake.results.push([]); // DELETE
    fake.results.push([]); // INSERT
    const res = await call({ persona_id: "p-1", bot_token: "tok" });
    const body = (await res.json()) as {
      commands_set: boolean;
      commands_error: string;
    };
    expect(body.commands_set).toBe(false);
    expect(body.commands_error).toBe("setMyCommands rate limited");
  });

  it("getMe returns ok:true but no username → 400", async () => {
    fake.results.push([]); // CREATE TABLE
    fake.results.push([persona]);
    fetchQueue.push({ ok: true, result: {} });
    const res = await call({ persona_id: "p-1", bot_token: "tok" });
    expect(res.status).toBe(400);
  });
});
