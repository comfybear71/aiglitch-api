import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = { url: string; init?: RequestInit; body?: unknown };
const fetchCalls: FetchCall[] = [];
let fetchQueue: Array<{ status?: number; body?: unknown } | Error> = [];

beforeEach(() => {
  fetchCalls.length = 0;
  fetchQueue = [];
  process.env.TELEGRAM_BOT_TOKEN = "tok-x";
  process.env.TELEGRAM_CHANNEL_ID = "-100admin";
  process.env.NEXT_PUBLIC_APP_URL = "https://api.aiglitch.app";
  delete process.env.TELEGRAM_GROUP_ID;
  delete process.env.CRON_SECRET;
  vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    const body = init?.body
      ? typeof init.body === "string"
        ? JSON.parse(init.body)
        : init.body
      : undefined;
    fetchCalls.push({ url: String(url), init: init as RequestInit, body });
    const next = fetchQueue.shift();
    if (!next) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? { ok: true }), {
      status: next.status ?? 200,
    });
  });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHANNEL_ID;
  delete process.env.TELEGRAM_GROUP_ID;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

async function postUpdate(update: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(update),
  });
  return mod.POST(req);
}

async function getRoute(query = "") {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/telegram/webhook${query}`,
    { method: "GET" },
  );
  return mod.GET(req);
}

describe("POST /api/telegram/webhook", () => {
  it("500 when bot env not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = await postUpdate({});
    expect(res.status).toBe(500);
  });

  it("returns ok:true for invalid JSON (Telegram requires 200)", async () => {
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{bad",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns ok:true when no message in update", async () => {
    const res = await postUpdate({ update_id: 1 });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // No fetch calls — we returned before any handler
    expect(fetchCalls).toHaveLength(0);
  });

  it("/chatid works from any chat (including unauthorized)", async () => {
    const res = await postUpdate({
      message: {
        text: "/chatid",
        chat: { id: -1009999, type: "group" },
      },
    });
    expect(res.status).toBe(200);
    const sendCall = fetchCalls.find((c) => c.url.includes("/sendMessage"));
    expect(sendCall).toBeDefined();
    const body = sendCall!.body as { text: string };
    expect(body.text).toContain("Chat Info");
    expect(body.text).toContain("-1009999");
    expect(body.text).toContain("group");
  });

  it("ignores non-/chatid commands from unauthorized chats", async () => {
    const res = await postUpdate({
      message: {
        text: "/help",
        chat: { id: -1009999, type: "group" },
      },
    });
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(0);
  });

  it("/help replies with command menu", async () => {
    await postUpdate({
      message: {
        text: "/help",
        chat: { id: -100, type: "private" },
      },
    });
    // The route checks against TELEGRAM_CHANNEL_ID = "-100admin"; -100 won't match
    // — re-run with the right id.
    fetchCalls.length = 0;
    await postUpdate({
      message: {
        text: "/help",
        chat: { id: "-100admin", type: "private" },
      },
    });
    const sendCall = fetchCalls.find((c) => c.url.includes("/sendMessage"));
    expect(sendCall).toBeDefined();
    expect((sendCall!.body as { text: string }).text).toContain(
      "AIG!itch Bot Commands",
    );
  });

  it("/start aliases to /help", async () => {
    await postUpdate({
      message: {
        text: "/start",
        chat: { id: "-100admin", type: "private" },
      },
    });
    const sendCall = fetchCalls.find((c) => c.url.includes("/sendMessage"));
    expect((sendCall!.body as { text: string }).text).toContain(
      "AIG!itch Bot Commands",
    );
  });

  it("unknown command replies with hint when starts with /", async () => {
    await postUpdate({
      message: {
        text: "/wibble",
        chat: { id: "-100admin", type: "private" },
      },
    });
    const sendCall = fetchCalls.find((c) => c.url.includes("/sendMessage"));
    expect((sendCall!.body as { text: string }).text).toContain(
      "Unknown command",
    );
  });

  it("plain non-command text is ignored silently", async () => {
    await postUpdate({
      message: {
        text: "hello bot",
        chat: { id: "-100admin", type: "private" },
      },
    });
    const sendCall = fetchCalls.find((c) => c.url.includes("/sendMessage"));
    expect(sendCall).toBeUndefined();
  });

  it("/hatch dispatches to /api/admin/hatchery and replies with persona", async () => {
    fetchQueue.push({ body: { ok: true } }); // initial reply (acknowledge)
    fetchQueue.push({
      // internal call result
      body: {
        success: true,
        persona: {
          avatar_emoji: "✨",
          display_name: "Stella",
          username: "stella",
          bio: "cosmic",
        },
        glitchAmount: 1000,
      },
    });
    fetchQueue.push({ body: { ok: true } }); // final result reply

    await postUpdate({
      message: {
        text: "/hatch alien",
        chat: { id: "-100admin", type: "private" },
      },
    });

    const internalCall = fetchCalls.find((c) =>
      c.url.includes("/api/admin/hatchery"),
    );
    expect(internalCall).toBeDefined();
    expect(internalCall!.body).toMatchObject({ type: "alien" });

    // Final reply contains the hatched name
    const replies = fetchCalls.filter((c) => c.url.includes("/sendMessage"));
    expect(replies.some((r) => (r.body as { text: string }).text.includes("Stella"))).toBe(true);
  });

  it("/hatch with no args sends empty body", async () => {
    fetchQueue.push({ body: { ok: true } }); // ack reply
    fetchQueue.push({ body: { success: true, persona: { display_name: "X" } } });
    fetchQueue.push({ body: { ok: true } });
    await postUpdate({
      message: {
        text: "/hatch",
        chat: { id: "-100admin", type: "private" },
      },
    });
    const internalCall = fetchCalls.find((c) =>
      c.url.includes("/api/admin/hatchery"),
    );
    expect(internalCall!.body).toEqual({});
  });

  it("CRON_SECRET attached as Bearer when set", async () => {
    process.env.CRON_SECRET = "sec-x";
    fetchQueue.push({ body: { ok: true } }); // ack
    fetchQueue.push({ body: { success: true, persona: { display_name: "X" } } });
    fetchQueue.push({ body: { ok: true } });
    await postUpdate({
      message: {
        text: "/hatch",
        chat: { id: "-100admin", type: "private" },
      },
    });
    const internalCall = fetchCalls.find((c) =>
      c.url.includes("/api/admin/hatchery"),
    );
    const authHeader = (internalCall!.init!.headers as Record<string, string>)
      .Authorization;
    expect(authHeader).toBe("Bearer sec-x");
  });
});

describe("GET /api/telegram/webhook", () => {
  it("500 when bot token not set", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = await getRoute();
    expect(res.status).toBe(500);
  });

  it("default action=info hits getWebhookInfo", async () => {
    fetchQueue.push({ body: { result: { url: "https://x" } } });
    const res = await getRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("info");
    expect(fetchCalls[0]!.url).toContain("getWebhookInfo");
  });

  it("?action=register hits setWebhook + setMyCommands", async () => {
    fetchQueue.push({ body: { ok: true } }); // setWebhook
    fetchQueue.push({ body: { ok: true } }); // setMyCommands
    const res = await getRoute("?action=register");
    expect(res.status).toBe(200);
    const setWebhook = fetchCalls.find((c) => c.url.includes("setWebhook"));
    const setMyCommands = fetchCalls.find((c) =>
      c.url.includes("setMyCommands"),
    );
    expect(setWebhook).toBeDefined();
    expect(setMyCommands).toBeDefined();
    const wh = setWebhook!.body as { url: string; allowed_updates: string[] };
    expect(wh.url).toBe("https://api.aiglitch.app/api/telegram/webhook");
    expect(wh.allowed_updates).toEqual(["message"]);
  });

  it("?action=register 500 when NEXT_PUBLIC_APP_URL missing", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = await getRoute("?action=register");
    expect(res.status).toBe(500);
  });

  it("?action=unregister hits deleteWebhook", async () => {
    fetchQueue.push({ body: { ok: true } });
    const res = await getRoute("?action=unregister");
    expect(res.status).toBe(200);
    expect(fetchCalls[0]!.url).toContain("deleteWebhook");
  });
});
