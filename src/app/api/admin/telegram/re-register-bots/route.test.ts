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
  queue: [] as (CommandsResult | Error)[],
};

vi.mock("@/lib/telegram/commands", () => ({
  registerTelegramCommands: (botToken: string) => {
    commands.calls.push(botToken);
    const next = commands.queue.shift();
    if (!next) return Promise.resolve({ ok: true });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
}));

type FetchCall = { url: string; body: unknown };
const fetchCalls: FetchCall[] = [];
let fetchQueue: Array<{ ok: boolean; description?: string } | Error> = [];

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  commands.calls = [];
  commands.queue = [];
  fetchCalls.length = 0;
  fetchQueue = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.NEXT_PUBLIC_APP_URL = "https://api.aiglitch.app";
  vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
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

async function call(
  method: "GET" | "POST",
  body?: unknown,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(
    "http://localhost/api/admin/telegram/re-register-bots",
    init,
  );
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/telegram/re-register-bots", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns bots without bot_token", async () => {
    mockIsAdmin = true;
    fake.results.push([
      {
        persona_id: "p-1",
        bot_username: "stella_bot",
        display_name: "Stella",
        avatar_emoji: "✨",
      },
      {
        persona_id: "p-2",
        bot_username: "grok_bot",
        display_name: "Grok",
        avatar_emoji: "🤖",
      },
    ]);
    const res = await call("GET");
    const body = (await res.json()) as {
      total: number;
      bots: Record<string, unknown>[];
    };
    expect(body.total).toBe(2);
    expect(body.bots).toHaveLength(2);
    for (const bot of body.bots) {
      expect(bot).not.toHaveProperty("bot_token");
    }
  });
});

describe("POST /api/admin/telegram/re-register-bots", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", {})).status).toBe(401);
  });

  it("500 when NEXT_PUBLIC_APP_URL missing", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    mockIsAdmin = true;
    expect((await call("POST", {})).status).toBe(500);
  });

  it("single-bot mode — 404 when persona not found", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // lookup empty
    const res = await call("POST", { persona_id: "missing" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; status: string };
    expect(body.success).toBe(false);
    expect(body.status).toBe("not_found");
  });

  it("single-bot happy path — setWebhook ok + commands registered", async () => {
    mockIsAdmin = true;
    fake.results.push([
      { persona_id: "p-1", bot_token: "token-1", bot_username: "stella_bot" },
    ]);
    fetchQueue.push({ ok: true });
    commands.queue.push({ ok: true });

    const res = await call("POST", { persona_id: "p-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      persona_id: string;
      status: string;
      commands_set: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.commands_set).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://api.telegram.org/bottoken-1/setWebhook",
    );
    const sentBody = fetchCalls[0]!.body as {
      url: string;
      allowed_updates: string[];
    };
    expect(sentBody.url).toBe(
      "https://api.aiglitch.app/api/telegram/persona-chat/p-1",
    );
    expect(sentBody.allowed_updates).toEqual(["message", "message_reaction"]);
    expect(commands.calls).toEqual(["token-1"]);
  });

  it("single-bot — setWebhook returns ok:false → failed", async () => {
    mockIsAdmin = true;
    fake.results.push([
      { persona_id: "p-1", bot_token: "token-1", bot_username: "stella_bot" },
    ]);
    fetchQueue.push({ ok: false, description: "invalid token" });

    const res = await call("POST", { persona_id: "p-1" });
    const body = (await res.json()) as {
      success: boolean;
      status: string;
      message: string;
    };
    expect(body.success).toBe(false);
    expect(body.status).toBe("failed");
    expect(body.message).toBe("invalid token");
    expect(commands.calls).toHaveLength(0);
  });

  it("single-bot — fetch throws → failed with error message", async () => {
    mockIsAdmin = true;
    fake.results.push([
      { persona_id: "p-1", bot_token: "token-1", bot_username: "stella_bot" },
    ]);
    fetchQueue.push(new Error("network down"));

    const res = await call("POST", { persona_id: "p-1" });
    const body = (await res.json()) as { status: string; message: string };
    expect(body.status).toBe("failed");
    expect(body.message).toBe("network down");
  });

  it("bulk mode — loops every active bot with details", async () => {
    mockIsAdmin = true;
    fake.results.push([
      { persona_id: "p-1", bot_token: "token-1", bot_username: "stella_bot" },
      { persona_id: "p-2", bot_token: "token-2", bot_username: "grok_bot" },
      { persona_id: "p-3", bot_token: "token-3", bot_username: "pip_bot" },
    ]);
    fetchQueue.push({ ok: true });
    fetchQueue.push({ ok: false, description: "grok down" });
    fetchQueue.push({ ok: true });

    const res = await call("POST", {});
    const body = (await res.json()) as {
      success: boolean;
      total: number;
      updated: number;
      errors: number;
      details: Array<{ persona_id: string; status: string; message?: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.total).toBe(3);
    expect(body.updated).toBe(2);
    expect(body.errors).toBe(1);
    expect(body.details).toHaveLength(3);
    const failed = body.details.find((d) => d.status === "failed");
    expect(failed?.persona_id).toBe("p-2");
    expect(failed?.message).toBe("grok down");
  });

  it("bulk mode — empty bot list returns zero-count success", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    const res = await call("POST", {});
    const body = (await res.json()) as {
      success: boolean;
      total: number;
      updated: number;
      errors: number;
    };
    expect(body.success).toBe(true);
    expect(body.total).toBe(0);
    expect(body.updated).toBe(0);
    expect(body.errors).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("empty body triggers bulk mode (not single)", async () => {
    mockIsAdmin = true;
    fake.results.push([
      { persona_id: "p-1", bot_token: "token-1", bot_username: "stella_bot" },
    ]);
    fetchQueue.push({ ok: true });

    const res = await call("POST", {});
    const body = (await res.json()) as { total: number; updated: number };
    expect(body.total).toBe(1);
    expect(body.updated).toBe(1);
  });

  it("non-JSON body still treated as empty → bulk mode", async () => {
    mockIsAdmin = true;
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      "http://localhost/api/admin/telegram/re-register-bots",
      {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: "not-json",
      },
    );
    fake.results.push([]);
    const res = await mod.POST(req);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });
});
