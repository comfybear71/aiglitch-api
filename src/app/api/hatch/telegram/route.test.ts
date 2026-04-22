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

type FetchCall = { url: string; body?: unknown };
const fetchCalls: FetchCall[] = [];
let fetchQueue: Array<
  { ok: boolean; description?: string; result?: { username?: string } } | Error
> = [];

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
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

async function callPost(body?: unknown) {
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
  const req = new NextRequest("http://localhost/api/hatch/telegram", init);
  return mod.POST(req);
}

async function callDelete(body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = {
    method: "DELETE",
  };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/hatch/telegram", init);
  return mod.DELETE(req);
}

describe("POST /api/hatch/telegram", () => {
  it("400 on invalid body JSON", async () => {
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/hatch/telegram", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "not-json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("400 when session_id or bot_token missing", async () => {
    expect((await callPost({})).status).toBe(400);
    expect((await callPost({ session_id: "s" })).status).toBe(400);
    expect((await callPost({ session_id: "s", bot_token: "  " })).status).toBe(
      400,
    );
  });

  it("403 when session has no wallet", async () => {
    fake.results.push([{ phantom_wallet_address: null }]);
    const res = await callPost({ session_id: "s", bot_token: "tok" });
    expect(res.status).toBe(403);
  });

  it("404 when wallet has no hatched persona", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([]); // persona lookup
    const res = await callPost({ session_id: "s", bot_token: "tok" });
    expect(res.status).toBe(404);
  });

  it("invalid bot token (getMe ok:false) → 400, no DB writes", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([{ id: "p-1", display_name: "Stella", username: "stella" }]);
    fetchQueue.push({ ok: false, description: "Not Found" });
    const res = await callPost({ session_id: "s", bot_token: "bad" });
    expect(res.status).toBe(400);
    const deleteCall = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM persona_telegram_bots"),
    );
    expect(deleteCall).toBeUndefined();
  });

  it("getMe network exception → 500", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([{ id: "p-1", display_name: "Stella", username: "stella" }]);
    fetchQueue.push(new Error("network down"));
    const res = await callPost({ session_id: "s", bot_token: "tok" });
    expect(res.status).toBe(500);
  });

  it("happy path — token valid + webhook ok + DELETE/INSERT + bot_username returned", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([{ id: "p-1", display_name: "Stella", username: "stella" }]);
    fetchQueue.push({ ok: true, result: { username: "stella_bot" } }); // getMe
    fetchQueue.push({ ok: true }); // setWebhook
    fake.results.push([]); // DELETE
    fake.results.push([]); // INSERT
    const res = await callPost({ session_id: "s", bot_token: "tok-x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      bot_username: string;
      webhook_set: boolean;
      message: string;
    };
    expect(body.success).toBe(true);
    expect(body.bot_username).toBe("stella_bot");
    expect(body.webhook_set).toBe(true);
    expect(body.message).toContain("Stella");

    const webhookCall = fetchCalls.find((c) => c.url.includes("setWebhook"));
    expect((webhookCall!.body as { url: string }).url).toBe(
      "https://api.aiglitch.app/api/telegram/persona-chat/p-1",
    );

    // DELETE before INSERT
    const deleteIdx = fake.calls.findIndex((c) =>
      c.strings.join("?").includes("DELETE FROM persona_telegram_bots"),
    );
    const insertIdx = fake.calls.findIndex((c) =>
      c.strings.join("?").includes("INSERT INTO persona_telegram_bots"),
    );
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
  });

  it("webhook failure is non-fatal — DB row still inserts", async () => {
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([{ id: "p-1", display_name: "S", username: "s" }]);
    fetchQueue.push({ ok: true, result: { username: "s_bot" } });
    fetchQueue.push({ ok: false }); // webhook fails
    fake.results.push([]); // DELETE
    fake.results.push([]); // INSERT
    const res = await callPost({ session_id: "s", bot_token: "t" });
    const body = (await res.json()) as {
      success: boolean;
      webhook_set: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.webhook_set).toBe(false);
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO persona_telegram_bots"),
    );
    expect(insert).toBeDefined();
  });

  it("falls back to request.url origin when NEXT_PUBLIC_APP_URL missing", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    fake.results.push([{ phantom_wallet_address: "wallet-abc" }]);
    fake.results.push([{ id: "p-1", display_name: "S", username: "s" }]);
    fetchQueue.push({ ok: true, result: { username: "b" } });
    fetchQueue.push({ ok: true });
    fake.results.push([]);
    fake.results.push([]);
    await callPost({ session_id: "s", bot_token: "t" });
    const webhookCall = fetchCalls.find((c) => c.url.includes("setWebhook"));
    const webhookUrl = (webhookCall!.body as { url: string }).url;
    // request.url was http://localhost/... so origin = http://localhost
    expect(webhookUrl).toMatch(/^http:\/\/localhost\/api\/telegram\/persona-chat\//);
  });
});

describe("DELETE /api/hatch/telegram", () => {
  it("400 on invalid body", async () => {
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/hatch/telegram", {
      method: "DELETE",
      headers: new Headers({ "content-type": "application/json" }),
      body: "not-json",
    });
    const res = await mod.DELETE(req);
    expect(res.status).toBe(400);
  });

  it("400 when session_id missing", async () => {
    expect((await callDelete({})).status).toBe(400);
  });

  it("403 when no wallet", async () => {
    fake.results.push([{ phantom_wallet_address: null }]);
    expect((await callDelete({ session_id: "s" })).status).toBe(403);
  });

  it("404 when no persona", async () => {
    fake.results.push([{ phantom_wallet_address: "w" }]);
    fake.results.push([]);
    expect((await callDelete({ session_id: "s" })).status).toBe(404);
  });

  it("happy path — unregisters webhook + deletes row", async () => {
    fake.results.push([{ phantom_wallet_address: "w" }]);
    fake.results.push([{ id: "p-1", display_name: "S", username: "s" }]);
    fake.results.push([{ bot_token: "tok-x" }]); // bot lookup
    fake.results.push([]); // DELETE

    const res = await callDelete({ session_id: "s" });
    expect(res.status).toBe(200);
    const deleteWebhook = fetchCalls.find((c) =>
      c.url.includes("deleteWebhook"),
    );
    expect(deleteWebhook).toBeDefined();
    const del = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM persona_telegram_bots"),
    );
    expect(del).toBeDefined();
  });

  it("no existing bot → still deletes row (no webhook unregister call)", async () => {
    fake.results.push([{ phantom_wallet_address: "w" }]);
    fake.results.push([{ id: "p-1", display_name: "S", username: "s" }]);
    fake.results.push([]); // bot lookup empty
    fake.results.push([]); // DELETE

    await callDelete({ session_id: "s" });
    const deleteWebhook = fetchCalls.find((c) =>
      c.url.includes("deleteWebhook"),
    );
    expect(deleteWebhook).toBeUndefined();
  });

  it("webhook cleanup exception is swallowed — DB DELETE still runs", async () => {
    fake.results.push([{ phantom_wallet_address: "w" }]);
    fake.results.push([{ id: "p-1", display_name: "S", username: "s" }]);
    fake.results.push([{ bot_token: "tok-x" }]);
    fetchQueue.push(new Error("telegram down"));
    fake.results.push([]); // DELETE

    const res = await callDelete({ session_id: "s" });
    expect(res.status).toBe(200);
    const del = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM persona_telegram_bots"),
    );
    expect(del).toBeDefined();
  });
});
