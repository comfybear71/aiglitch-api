import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ai/generate", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/content/platform-brief", () => ({
  buildPlatformBriefBlock: vi.fn(async () => ""),
}));
vi.mock("@/lib/content/outreach-drafts", () => ({
  getPendingDraft: vi.fn(async () => null),
  detectApprovalAction: vi.fn(() => ({ action: "none" })),
  hasOutreachKeyword: vi.fn(() => false),
  detectOutreachIntent: vi.fn(async () => ({ outreach: false, tag: null, topic: "" })),
  pickContactForOutreach: vi.fn(),
  findContactDirect: vi.fn(),
  listContactsForPersona: vi.fn(async () => []),
  draftOutreachEmail: vi.fn(),
  saveDraft: vi.fn(async () => "draft-id"),
  cancelDraft: vi.fn(),
  sendApprovedDraft: vi.fn(),
  formatDraftPreview: vi.fn(
    (_a, _b, _c, subject: string, body: string) => `PREVIEW:${subject}:${body}`,
  ),
}));
vi.mock("@/lib/telegram/commands", () => ({
  handleSlashCommand: vi.fn(async () => ({ handled: false })),
  getPersonaMode: vi.fn(async () => "default"),
  getModeOverlay: vi.fn(() => ""),
}));
vi.mock("@/lib/repositories/personas", () => ({
  getWalletInfo: vi.fn(async () => null),
}));

import { generateText } from "@/lib/ai/generate";
import {
  detectApprovalAction,
  detectOutreachIntent,
  findContactDirect,
  getPendingDraft,
  hasOutreachKeyword,
  listContactsForPersona,
  pickContactForOutreach,
  sendApprovedDraft,
  draftOutreachEmail,
} from "@/lib/content/outreach-drafts";
import { getDb } from "@/lib/db";
import { handleSlashCommand } from "@/lib/telegram/commands";
import { NextRequest } from "next/server";
import { POST } from "./route";

type FetchCall = { url: string; body: unknown };

let fetchCalls: FetchCall[] = [];

function stubFetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    }),
  );
}

function fakeSql(handler: (sql: string, params: unknown[]) => unknown) {
  const queries: string[] = [];
  const sqlFn = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = Array.from(strings).join(" ");
    queries.push(sql);
    const result = handler(sql, params);
    const promise = Promise.resolve(result ?? []) as Promise<unknown[]> & {
      catch: (fn: (e: unknown) => void) => Promise<unknown[]>;
    };
    promise.catch = () => promise;
    return promise;
  };
  return { sqlFn, queries };
}

const PERSONA_ROW = {
  id: "persona-1",
  username: "grok",
  display_name: "Grok",
  personality: "witty",
  bio: "xAI persona",
  persona_type: "ai",
  avatar_emoji: "🤖",
  meatbag_name: "Stuart",
  owner_wallet_address: null,
  bot_token: "bot-token-abc",
  telegram_chat_id: "42",
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/telegram/persona-chat/persona-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ personaId: "persona-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  fetchCalls = [];
  stubFetchOk();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/telegram/persona-chat/[personaId] — webhook parse", () => {
  it("returns 200 for malformed body", async () => {
    const req = new NextRequest(
      "http://localhost/api/telegram/persona-chat/persona-1",
      { method: "POST", body: "not json" },
    );
    const res = await POST(req, PARAMS);
    expect(res.status).toBe(200);
  });

  it("returns 200 for update without message/text", async () => {
    const res = await POST(makeRequest({ update_id: 1 }), PARAMS);
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(0);
  });

  it("returns 200 and skips persona lookup when persona is not active", async () => {
    const { sqlFn } = fakeSql(() => []); // no persona rows
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "hi", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(0); // no Telegram sends
  });
});

describe("POST — /start and /memories shortcuts", () => {
  it("/start sends welcome when persona exists", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.display_name, p.avatar_emoji")
        ? [
            {
              display_name: "Grok",
              avatar_emoji: "🤖",
              bio: "xAI persona",
              meatbag_name: "Stuart",
              bot_token: "bot-abc",
            },
          ]
        : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/start", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const send = fetchCalls.find((c) => c.url.includes("sendMessage"));
    expect(send).toBeTruthy();
    expect((send!.body as { text: string }).text).toContain("Grok");
    expect((send!.body as { text: string }).text).toContain("/help");
  });

  it("/start silently 200s when persona doesn't exist", async () => {
    vi.mocked(getDb).mockReturnValue(fakeSql(() => []).sqlFn as never);
    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/start", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(0);
  });

  it("/memories — empty memories produces 'don't have any memories yet' reply", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("SELECT p.display_name, p.meatbag_name")) {
        return [
          {
            display_name: "Grok",
            meatbag_name: "Stuart",
            bot_token: "bot-abc",
          },
        ];
      }
      if (sql.includes("FROM persona_memories")) return [];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/memories", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const send = fetchCalls.find((c) => c.url.includes("sendMessage"));
    expect((send!.body as { text: string }).text).toContain(
      "don't have any memories",
    );
  });

  it("/memories — renders memories grouped by category with star confidence", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("SELECT p.display_name, p.meatbag_name")) {
        return [
          {
            display_name: "Grok",
            meatbag_name: "Stuart",
            bot_token: "bot-abc",
          },
        ];
      }
      if (sql.includes("FROM persona_memories")) {
        return [
          {
            memory_type: "fact",
            category: "hobbies",
            content: "loves hiking",
            confidence: 0.95,
            times_reinforced: 4,
          },
          {
            memory_type: "preference",
            category: "food",
            content: "prefers ramen",
            confidence: 0.7,
            times_reinforced: 1,
          },
        ];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/memories", message_id: 1 },
      }),
      PARAMS,
    );
    const text = (fetchCalls[0]!.body as { text: string }).text;
    expect(text).toContain("HOBBIES");
    expect(text).toContain("★ loves hiking");
    expect(text).toContain("FOOD");
    expect(text).toContain("☆ prefers ramen");
    expect(text).toContain("Total memories: 2");
  });
});

describe("POST — /email command", () => {
  it("blocks /email in non-private chats with a friendly redirect", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const res = await POST(
      makeRequest({
        message: {
          chat: { id: 42, type: "group" },
          text: "/email family",
          message_id: 1,
        },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const send = fetchCalls.find((c) => c.url.includes("sendMessage"));
    expect(send).toBeTruthy();
    expect((send!.body as { text: string }).text).toContain("DM");
  });

  it("/email with no args lists contacts", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(listContactsForPersona).mockResolvedValue([
      {
        id: "c1",
        name: "Andrew",
        email: "andrew@x.com",
        company: null,
        tags: ["family"],
        assigned_persona_id: null,
        notes: null,
        last_emailed_at: null,
        email_count: 0,
      },
    ]);

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/email", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = fetchCalls[0]!.body as { text: string };
    expect(body.text).toContain("/email andrew@x.com");
  });

  it("/email <query> drafts + saves + sends preview when contact found", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(findContactDirect).mockResolvedValue({
      contact: {
        id: "c1",
        name: "Andrew",
        email: "andrew@x.com",
        company: "Acme",
        tags: ["family"],
        assigned_persona_id: null,
        notes: null,
        last_emailed_at: null,
        email_count: 0,
      },
      reason: "",
    });
    vi.mocked(draftOutreachEmail).mockResolvedValue({
      subject: "Hi Andrew",
      body: "Body here",
    });

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/email family", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const sends = fetchCalls.filter((c) => c.url.includes("sendMessage"));
    // "Drafting..." + preview
    expect(sends.length).toBe(2);
    expect((sends[1]!.body as { text: string }).text).toContain("PREVIEW:Hi Andrew:Body here");
  });
});

describe("POST — slash-command dispatch", () => {
  it("/help delegates to handleSlashCommand and early-returns on handled=true", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(handleSlashCommand).mockResolvedValue({ handled: true });

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/help", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(handleSlashCommand)).toHaveBeenCalled();
    // safeGenerate / AI flow should not have run
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it("falls through to normal chat if handleSlashCommand returns handled=false", async () => {
    const { sqlFn } = fakeSql((sql, _params) => {
      if (sql.includes("SELECT p.id, p.username")) return [PERSONA_ROW];
      if (sql.includes("FROM persona_memories")) return [];
      if (sql.includes("FROM messages")) return [];
      if (sql.includes("FROM conversations")) return [];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(handleSlashCommand).mockResolvedValue({ handled: false });
    vi.mocked(generateText).mockResolvedValue("Hey Stuart!");

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "/totallybogus", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(generateText)).toHaveBeenCalled();
  });
});

describe("POST — normal chat flow", () => {
  it("builds system prompt + saves conversation + sends reply", async () => {
    const queries: string[] = [];
    const { sqlFn } = fakeSql((sql) => {
      queries.push(sql);
      if (sql.includes("SELECT p.id, p.username")) return [PERSONA_ROW];
      if (sql.includes("FROM persona_memories"))
        return [
          {
            memory_type: "fact",
            category: "hobbies",
            content: "loves hiking",
            confidence: 0.9,
            times_reinforced: 3,
          },
        ];
      if (sql.includes("FROM conversations WHERE persona_id")) return [];
      if (sql.includes("FROM messages")) return [];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(generateText).mockResolvedValue("Glad you're back, Stuart.");

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "How are you?", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const call = vi.mocked(generateText).mock.calls[0]![0]!;
    expect(call.userPrompt).toContain("loves hiking");
    expect(call.userPrompt).toContain("How are you?");
    expect(call.taskType).toBe("telegram_message");

    const lastSend = fetchCalls[fetchCalls.length - 1]!;
    expect(lastSend.url).toContain("sendMessage");
    expect((lastSend.body as { text: string }).text).toBe(
      "Glad you're back, Stuart.",
    );

    // Conversation row created (+ 2 message inserts)
    expect(queries.some((q) => q.includes("INSERT INTO conversations"))).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO messages"))).toBe(true);
  });

  it("uses fallback reply when generateText returns empty string", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("SELECT p.id, p.username")) return [PERSONA_ROW];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(generateText).mockResolvedValue("   ");

    const res = await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "yo", message_id: 1 },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const lastSend = fetchCalls[fetchCalls.length - 1]!;
    expect((lastSend.body as { text: string }).text).toContain("circuits are a bit fuzzy");
  });

  it("strips wrapping quotes from AI reply", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(generateText).mockResolvedValue('"Sure thing!"');

    await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "hi", message_id: 1 },
      }),
      PARAMS,
    );
    const lastSend = fetchCalls[fetchCalls.length - 1]!;
    expect((lastSend.body as { text: string }).text).toBe("Sure thing!");
  });
});

describe("POST — outreach approval flow", () => {
  const draft = {
    id: "d1",
    persona_id: "persona-1",
    chat_id: "42",
    contact_id: "c1",
    to_email: "andrew@x.com",
    subject: "s",
    body: "b",
    status: "pending",
    created_at: "2026-04-22T00:00:00Z",
  };

  it("approve → sendApprovedDraft + confirmation", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(getPendingDraft).mockResolvedValue(draft);
    vi.mocked(detectApprovalAction).mockReturnValue({ action: "approve" });
    vi.mocked(sendApprovedDraft).mockResolvedValue({
      success: true,
      resend_id: "re_123",
    });

    await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "approve", message_id: 1 },
      }),
      PARAMS,
    );
    expect(vi.mocked(sendApprovedDraft)).toHaveBeenCalled();
    const lastSend = fetchCalls[fetchCalls.length - 1]!;
    expect((lastSend.body as { text: string }).text).toContain("Email sent!");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it("action=none reminds about pending draft but falls through to AI reply", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("SELECT p.id, p.username")) return [PERSONA_ROW];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(getPendingDraft).mockResolvedValue(draft);
    vi.mocked(detectApprovalAction).mockReturnValue({ action: "none" });
    vi.mocked(generateText).mockResolvedValue("chat continues");

    await POST(
      makeRequest({
        message: {
          chat: { id: 42 },
          text: "tell me a joke",
          message_id: 1,
        },
      }),
      PARAMS,
    );
    const reminder = fetchCalls.find((c) =>
      (c.body as { text: string }).text.includes("still have a draft"),
    );
    expect(reminder).toBeTruthy();
    expect(vi.mocked(generateText)).toHaveBeenCalled();
  });
});

describe("POST — keyword-triggered intent drafting", () => {
  it("pickContactForOutreach null → user gets a helpful reply", async () => {
    const { sqlFn } = fakeSql((sql) =>
      sql.includes("SELECT p.id, p.username") ? [PERSONA_ROW] : [],
    );
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(getPendingDraft).mockResolvedValue(null);
    vi.mocked(hasOutreachKeyword).mockReturnValue(true);
    vi.mocked(detectOutreachIntent).mockResolvedValue({
      outreach: true,
      tag: "grants",
      topic: "quarterly update",
    });
    vi.mocked(pickContactForOutreach).mockResolvedValue({
      contact: null,
      reason: "No eligible contacts",
    });

    await POST(
      makeRequest({
        message: {
          chat: { id: 42 },
          text: "email my grants list",
          message_id: 1,
        },
      }),
      PARAMS,
    );
    const send = fetchCalls.find((c) =>
      (c.body as { text: string }).text.includes("tried to find a contact"),
    );
    expect(send).toBeTruthy();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });
});

describe("POST — message_reaction branch", () => {
  it("returns 200 immediately for message_reaction updates (fire-and-forget)", async () => {
    // handleMessageReaction runs async — provide a sql mock so its catch path
    // doesn't throw unhandled (which would pollute the test runner).
    vi.mocked(getDb).mockReturnValue(
      fakeSql(() => []).sqlFn as never,
    );
    const res = await POST(
      makeRequest({
        message_reaction: {
          chat: { id: 42 },
          message_id: 99,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "❤️" }],
        },
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
  });
});

describe("hashtag mentions (integration via main chat flow)", () => {
  it("does not look up personas when message has no hashtags", async () => {
    const { sqlFn, queries } = fakeSql((sql) => {
      if (sql.includes("SELECT p.id, p.username, p.display_name, p.personality, p.bio,\n           p.avatar_emoji, b.bot_token")) {
        // This is the hashtag lookup — should NOT run when no hashtags present.
        return [];
      }
      if (sql.includes("SELECT p.id, p.username")) return [PERSONA_ROW];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);
    vi.mocked(generateText).mockResolvedValue("hey");

    await POST(
      makeRequest({
        message: { chat: { id: 42 }, text: "plain message", message_id: 1 },
      }),
      PARAMS,
    );
    // CREATE TABLE persona_hashtag_cooldowns should not have run — no #tags.
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS persona_hashtag_cooldowns")),
    ).toBe(false);
  });
});
