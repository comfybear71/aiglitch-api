import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cronAuth = {
  fail: null as Response | null,
};

vi.mock("@/lib/cron-auth", () => ({
  requireCronAuth: () => cronAuth.fail,
}));

const telegram = {
  sendCalls: [] as { token: string; chatId: string; text: string }[],
  sendThrow: null as Error | null,
  channel: { token: "tok-x", chatId: "-100-y" } as
    | { token: string; chatId: string }
    | null,
};

vi.mock("@/lib/telegram", () => ({
  getAdminChannel: () => telegram.channel,
  sendMessage: (token: string, chatId: string, text: string) => {
    telegram.sendCalls.push({ token, chatId, text });
    if (telegram.sendThrow) return Promise.reject(telegram.sendThrow);
    return Promise.resolve();
  },
}));

beforeEach(() => {
  cronAuth.fail = null;
  telegram.sendCalls = [];
  telegram.sendThrow = null;
  telegram.channel = { token: "tok-x", chatId: "-100-y" };
  vi.resetModules();
});

afterEach(() => {
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
  const req = new NextRequest("http://localhost/api/telegram/notify", init);
  return mod.POST(req);
}

describe("POST /api/telegram/notify", () => {
  it("401 when cron auth fails", async () => {
    cronAuth.fail = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
    const res = await callPost({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("400 when message missing", async () => {
    const res = await callPost({});
    expect(res.status).toBe(400);
  });

  it("no-op when Telegram not configured", async () => {
    telegram.channel = null;
    const res = await callPost({ message: "hello" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("telegram-not-configured");
    expect(telegram.sendCalls).toHaveLength(0);
  });

  it("plain message sends verbatim (no title)", async () => {
    const res = await callPost({ message: "hello world" });
    expect(res.status).toBe(200);
    expect(telegram.sendCalls).toHaveLength(1);
    expect(telegram.sendCalls[0]!.text).toBe("hello world");
  });

  it("with title → formats as <b>title</b> with warning emoji default", async () => {
    await callPost({ title: "Credit Alert", message: "below threshold" });
    const text = telegram.sendCalls[0]!.text;
    expect(text).toContain("⚠️");
    expect(text).toContain("<b>Credit Alert</b>");
    expect(text).toContain("below threshold");
  });

  it("severity:'critical' uses 🚨 emoji", async () => {
    await callPost({
      title: "Down",
      message: "everything on fire",
      severity: "critical",
    });
    expect(telegram.sendCalls[0]!.text.startsWith("🚨")).toBe(true);
  });

  it("severity:'info' uses ℹ️ emoji", async () => {
    await callPost({
      title: "Heads up",
      message: "info here",
      severity: "info",
    });
    expect(telegram.sendCalls[0]!.text.startsWith("ℹ️")).toBe(true);
  });

  it("sendMessage throw → 500", async () => {
    telegram.sendThrow = new Error("telegram 502");
    const res = await callPost({ message: "hi" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("telegram 502");
  });
});
