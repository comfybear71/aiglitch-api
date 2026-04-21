import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTelegramCommands,
  TELEGRAM_COMMANDS_GROUP,
  TELEGRAM_COMMANDS_PRIVATE,
} from "./commands";

type Call = { url: string; body: unknown };

let calls: Call[] = [];
let responses: Array<{ ok: boolean; description?: string } | Error>;

beforeEach(() => {
  calls = [];
  responses = [];
  vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    calls.push({ url: String(url), body });
    const next = responses.shift();
    if (!next) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TELEGRAM_COMMANDS lists", () => {
  it("private list contains /email", () => {
    expect(TELEGRAM_COMMANDS_PRIVATE.some((c) => c.command === "email")).toBe(true);
  });

  it("group list drops /email", () => {
    expect(TELEGRAM_COMMANDS_GROUP.some((c) => c.command === "email")).toBe(false);
    expect(TELEGRAM_COMMANDS_GROUP.length).toBe(TELEGRAM_COMMANDS_PRIVATE.length - 1);
  });

  it("all descriptions fit Telegram's 256-char cap", () => {
    for (const cmd of TELEGRAM_COMMANDS_PRIVATE) {
      expect(cmd.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("registerTelegramCommands", () => {
  it("pushes two scoped menus and returns ok", async () => {
    const result = await registerTelegramCommands("bot-123");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/botbot-123/setMyCommands");
    expect((calls[0]!.body as { scope: { type: string } }).scope.type).toBe(
      "all_private_chats",
    );
    expect((calls[1]!.body as { scope: { type: string } }).scope.type).toBe(
      "all_group_chats",
    );
  });

  it("returns private failure up to caller", async () => {
    responses.push({ ok: false, description: "bot token invalid" });
    const result = await registerTelegramCommands("bot-bad");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bot token invalid");
  });

  it("group scope failure is a warning only — overall ok", async () => {
    responses.push({ ok: true }); // private OK
    responses.push({ ok: false, description: "group setMyCommands failed" }); // group FAIL
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await registerTelegramCommands("bot-abc");
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("fetch exception reported as !ok with error message", async () => {
    responses.push(new Error("network boom"));
    const result = await registerTelegramCommands("bot-fail");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network boom");
  });
});
