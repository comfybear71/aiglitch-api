import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/telegram", () => ({
  sendTelegramPhoto: vi.fn(async () => ({ ok: true })),
  sendTelegramVideo: vi.fn(async () => ({ ok: true })),
}));

import { getDb } from "@/lib/db";
import { sendTelegramPhoto, sendTelegramVideo } from "@/lib/telegram";
import {
  findMarketplaceProduct,
  getFeaturedProductsForBrowser,
  getModeOverlay,
  getPersonaMode,
  handleSlashCommand,
  PERSONALITY_MODES,
  registerTelegramCommands,
  setPersonaMode,
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

describe("personality modes", () => {
  it("PERSONALITY_MODES has every expected mode with an overlay", () => {
    const keys = ["default", "serious", "delusional", "brainiac", "whimsical", "fun", "unfiltered"];
    for (const k of keys) {
      expect(PERSONALITY_MODES[k as keyof typeof PERSONALITY_MODES]).toBeTruthy();
    }
    // Default mode has an empty overlay (no injection into system prompt)
    expect(PERSONALITY_MODES.default.overlay).toBe("");
    // Non-default modes have overlay text
    expect(PERSONALITY_MODES.brainiac.overlay.length).toBeGreaterThan(20);
  });

  it("getModeOverlay returns the overlay string for a known mode", () => {
    expect(getModeOverlay("default")).toBe("");
    expect(getModeOverlay("serious")).toContain("SERIOUS MODE");
  });

  it("getPersonaMode returns stored mode when present", async () => {
    const queries: string[] = [];
    const sql = (strings: TemplateStringsArray) => {
      const s = strings.join(" ");
      queries.push(s);
      if (s.includes("CREATE TABLE")) {
        const p = Promise.resolve([]) as Promise<unknown[]> & { catch: (fn: (e: unknown) => void) => Promise<unknown[]> };
        p.catch = () => p;
        return p;
      }
      if (s.includes("SELECT mode")) return Promise.resolve([{ mode: "brainiac" }]);
      return Promise.resolve([]);
    };
    vi.mocked(getDb).mockReturnValue(sql as never);

    const mode = await getPersonaMode("persona-1", 42);
    expect(mode).toBe("brainiac");
  });

  it("getPersonaMode falls back to default when no row", async () => {
    const sql = (strings: TemplateStringsArray) => {
      const s = strings.join(" ");
      if (s.includes("CREATE TABLE")) {
        const p = Promise.resolve([]) as Promise<unknown[]> & { catch: (fn: (e: unknown) => void) => Promise<unknown[]> };
        p.catch = () => p;
        return p;
      }
      return Promise.resolve([]);
    };
    vi.mocked(getDb).mockReturnValue(sql as never);

    expect(await getPersonaMode("persona-1", 42)).toBe("default");
  });

  it("getPersonaMode returns default on DB error", async () => {
    vi.mocked(getDb).mockReturnValue(
      (() => {
        throw new Error("db down");
      }) as never,
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getPersonaMode("persona-1", 42)).toBe("default");
    spy.mockRestore();
  });

  it("setPersonaMode issues INSERT ... ON CONFLICT", async () => {
    const queries: string[] = [];
    const sql = (strings: TemplateStringsArray, ..._params: unknown[]) => {
      const s = strings.join(" ");
      queries.push(s);
      if (s.includes("CREATE TABLE")) {
        const p = Promise.resolve([]) as Promise<unknown[]> & { catch: (fn: (e: unknown) => void) => Promise<unknown[]> };
        p.catch = () => p;
        return p;
      }
      return Promise.resolve([]);
    };
    vi.mocked(getDb).mockReturnValue(sql as never);

    await setPersonaMode("persona-1", 42, "unfiltered");
    const insert = queries.find((q) => q.includes("INSERT INTO persona_chat_modes"));
    expect(insert).toBeTruthy();
    expect(insert).toContain("ON CONFLICT");
  });
});

describe("content lookups", () => {
  it("findMarketplaceProduct finds a known product by keyword", () => {
    const hit = findMarketplaceProduct("butter");
    expect(hit).not.toBeNull();
  });

  it("findMarketplaceProduct returns null for empty query", () => {
    expect(findMarketplaceProduct("   ")).toBeNull();
  });

  it("findMarketplaceProduct returns null for nonsense query", () => {
    expect(findMarketplaceProduct("zzzxyz-nope-nope-123")).toBeNull();
  });

  it("getFeaturedProductsForBrowser caps at the limit", () => {
    const list = getFeaturedProductsForBrowser(5);
    expect(list.length).toBeLessThanOrEqual(5);
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("handleSlashCommand", () => {
  const makeCtx = (chatType: "private" | "group" = "private") => ({
    personaId: "persona-1",
    personaUsername: "grok",
    personaDisplayName: "Grok",
    botToken: "bot-token",
    chatId: 42,
    chatType,
  });

  it("returns { handled: false } for non-slash messages", async () => {
    const result = await handleSlashCommand("hello there", makeCtx());
    expect(result.handled).toBe(false);
  });

  it("handles /help and sends a message", async () => {
    const result = await handleSlashCommand("/help", makeCtx());
    expect(result.handled).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toContain("/sendMessage");
    const body = calls[0]!.body as { text: string; chat_id: number };
    expect(body.chat_id).toBe(42);
    expect(body.text).toContain("Grok");
    expect(body.text).toContain("/email"); // private-scope help includes /email
  });

  it("/help in a group chat hides /email", async () => {
    await handleSlashCommand("/help", makeCtx("group"));
    const body = calls[0]!.body as { text: string };
    expect(body.text).not.toContain("/email");
  });

  it("handles /modes", async () => {
    const result = await handleSlashCommand("/modes", makeCtx());
    expect(result.handled).toBe(true);
    const body = calls[0]!.body as { text: string };
    expect(body.text).toContain("Personality modes");
  });

  it("handles mode switch /brainiac and persists it", async () => {
    const queries: string[] = [];
    const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
      const s = strings.join(" ");
      queries.push(s);
      if (s.includes("CREATE TABLE")) {
        const p = Promise.resolve([]) as Promise<unknown[]> & { catch: (fn: (e: unknown) => void) => Promise<unknown[]> };
        p.catch = () => p;
        return p;
      }
      return Promise.resolve([]);
    };
    vi.mocked(getDb).mockReturnValue(sql as never);

    const result = await handleSlashCommand("/brainiac", makeCtx());
    expect(result.handled).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO persona_chat_modes"))).toBe(true);
    const body = calls[0]!.body as { text: string };
    expect(body.text).toContain("brainiac");
  });

  it("strips bot-suffix from group-chat commands: /nft@mybot <query>", async () => {
    const result = await handleSlashCommand("/nft@mybot butter", makeCtx("group"));
    expect(result.handled).toBe(true);
  });

  it("returns { handled: false } for unknown slash commands", async () => {
    const result = await handleSlashCommand("/totallybogus", makeCtx());
    expect(result.handled).toBe(false);
  });

  it("/nft with no args sends browser list", async () => {
    const result = await handleSlashCommand("/nft", makeCtx());
    expect(result.handled).toBe(true);
    const body = calls[0]!.body as { text: string };
    expect(body.text).toContain("Marketplace");
  });

  it("/channel with no args queries channels and sends list", async () => {
    const sql = (strings: TemplateStringsArray) => {
      const s = strings.join(" ");
      if (s.includes("FROM channels")) {
        return Promise.resolve([
          { slug: "ch-aitunes", name: "AITunes", emoji: "🎵" },
          { slug: "ch-gnn", name: "GNN", emoji: "📰" },
        ]);
      }
      return Promise.resolve([]);
    };
    vi.mocked(getDb).mockReturnValue(sql as never);

    const result = await handleSlashCommand("/channel", makeCtx());
    expect(result.handled).toBe(true);
    const body = calls[0]!.body as { text: string };
    expect(body.text).toContain("AITunes");
    expect(body.text).toContain("GNN");
  });

  it("/avatar <user> finds a persona and sends photo", async () => {
    const sql = (strings: TemplateStringsArray) => {
      const s = strings.join(" ");
      if (s.includes("FROM ai_personas")) {
        return Promise.resolve([
          {
            username: "claude",
            display_name: "Claude",
            avatar_url: "https://cdn.example/claude.png",
            avatar_emoji: "🤖",
            bio: "Anthropic's assistant.",
          },
        ]);
      }
      return Promise.resolve([]);
    };
    vi.mocked(getDb).mockReturnValue(sql as never);

    const result = await handleSlashCommand("/avatar claude", makeCtx());
    expect(result.handled).toBe(true);
    expect(vi.mocked(sendTelegramPhoto)).toHaveBeenCalled();
    expect(vi.mocked(sendTelegramVideo)).not.toHaveBeenCalled();
  });
});
