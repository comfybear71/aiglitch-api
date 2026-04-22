import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ai/generate", () => ({ generateText: vi.fn() }));

import { generateText } from "@/lib/ai/generate";
import { getDb } from "@/lib/db";
import {
  __resetOutreachTableCache,
  cancelDraft,
  detectApprovalAction,
  detectOutreachIntent,
  draftOutreachEmail,
  findContactDirect,
  formatDraftPreview,
  getPendingDraft,
  hasOutreachKeyword,
  listContactsForPersona,
  pickContactForOutreach,
  saveDraft,
  sendApprovedDraft,
  type Contact,
  type PendingDraft,
} from "./outreach-drafts";

type Call = { sql: string; params: unknown[] };

function fakeSql(handler: (sql: string, params: unknown[]) => unknown) {
  const calls: Call[] = [];
  const sqlFn = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = Array.from(strings).join(" ");
    calls.push({ sql, params });
    const result = handler(sql, params);
    return Promise.resolve(result ?? []);
  };
  return { sqlFn, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetOutreachTableCache();
});

describe("hasOutreachKeyword", () => {
  it("matches obvious outreach phrases", () => {
    expect(hasOutreachKeyword("Email my grants list about the update")).toBe(true);
    expect(hasOutreachKeyword("draft a note to Andrew")).toBe(true);
    expect(hasOutreachKeyword("reach out to the media")).toBe(true);
  });

  it("rejects unrelated chat", () => {
    expect(hasOutreachKeyword("What's for breakfast?")).toBe(false);
    expect(hasOutreachKeyword("How are you today")).toBe(false);
  });
});

describe("pickContactForOutreach", () => {
  it("returns null + reason when global daily ceiling hit", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("FROM email_sends")) return [{ c: 10 }];
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const result = await pickContactForOutreach("persona-1", null);
    expect(result.contact).toBeNull();
    expect(result.reason).toContain("Daily email ceiling hit");
  });

  it("bypasses ceiling + cooldown when bypassRateLimits=true", async () => {
    let contactQueried = false;
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("FROM email_sends")) {
        throw new Error("should not check email_sends when bypassing");
      }
      if (sql.includes("FROM contacts")) {
        contactQueried = true;
        expect(sql).not.toContain("last_emailed_at < NOW() - INTERVAL");
        return [
          {
            id: "c1",
            name: "Andrew",
            email: "andrew@example.com",
            company: null,
            tags: ["family"],
            assigned_persona_id: null,
            notes: null,
            last_emailed_at: null,
            email_count: 0,
          },
        ];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const result = await pickContactForOutreach("persona-1", "family", {
      bypassRateLimits: true,
    });
    expect(contactQueried).toBe(true);
    expect(result.contact?.name).toBe("Andrew");
  });

  it("uses cooldown clause when no bypass + no tag", async () => {
    let usedCooldownClause = false;
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("FROM email_sends")) return [{ c: 0 }];
      if (sql.includes("FROM contacts")) {
        if (sql.includes("last_emailed_at < NOW() - INTERVAL")) {
          usedCooldownClause = true;
        }
        return [];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const result = await pickContactForOutreach("persona-1", null);
    expect(usedCooldownClause).toBe(true);
    expect(result.contact).toBeNull();
    expect(result.reason).toContain("No eligible contacts");
  });

  it("uses tag cooldown branch when tag provided + no bypass", async () => {
    let sawJsonbBranch = false;
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("FROM email_sends")) return [{ c: 0 }];
      if (sql.includes("FROM contacts")) {
        if (
          sql.includes("jsonb_array_elements_text") &&
          sql.includes("last_emailed_at < NOW() - INTERVAL")
        ) {
          sawJsonbBranch = true;
        }
        return [];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    await pickContactForOutreach("persona-1", "grants");
    expect(sawJsonbBranch).toBe(true);
  });
});

describe("findContactDirect", () => {
  it("returns null + reason for empty query", async () => {
    vi.mocked(getDb).mockReturnValue((() => {
      throw new Error("should not be called for empty query");
    }) as never);
    const result = await findContactDirect("persona-1", "   ");
    expect(result.contact).toBeNull();
    expect(result.reason).toContain("No query");
  });

  it("falls back to email/name match when tag lookup returns nothing", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("FROM email_sends")) return [{ c: 0 }];
      if (sql.includes("jsonb_array_elements_text")) return []; // tag miss
      if (sql.includes("match_rank")) {
        return [
          {
            id: "c1",
            name: "Andrew",
            email: "andrew@example.com",
            company: null,
            tags: [],
            assigned_persona_id: null,
            notes: null,
            last_emailed_at: null,
            email_count: 0,
            match_rank: 1,
          },
        ];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const result = await findContactDirect("persona-1", "andrew");
    expect(result.contact?.name).toBe("Andrew");
  });
});

describe("listContactsForPersona", () => {
  it("SELECTs up to 50 contacts ordered by last_emailed_at", async () => {
    let ordering = "";
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("FROM contacts")) {
        ordering = sql;
        return [
          {
            id: "c1",
            name: "Andrew",
            email: "a@x",
            company: null,
            tags: [],
            assigned_persona_id: null,
            notes: null,
            last_emailed_at: null,
            email_count: 0,
          },
        ];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const list = await listContactsForPersona("persona-1");
    expect(list.length).toBe(1);
    expect(ordering).toContain("ORDER BY last_emailed_at");
    expect(ordering).toContain("LIMIT 50");
  });
});

describe("detectOutreachIntent", () => {
  it("parses outreach=true JSON from the LLM", async () => {
    vi.mocked(generateText).mockResolvedValue(
      'Here you go: {"outreach": true, "tag": "Grants", "topic": "new channel"} — done',
    );
    const intent = await detectOutreachIntent("Email my grants list");
    expect(intent.outreach).toBe(true);
    expect(intent.tag).toBe("grants");
    expect(intent.topic).toBe("new channel");
  });

  it("returns outreach=false when LLM returns null", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("circuit open"));
    const intent = await detectOutreachIntent("any message");
    expect(intent).toEqual({ outreach: false, tag: null, topic: "" });
  });

  it("falls back to outreach=false when LLM output is not JSON", async () => {
    vi.mocked(generateText).mockResolvedValue("no json at all");
    const intent = await detectOutreachIntent("any message");
    expect(intent.outreach).toBe(false);
  });
});

describe("draftOutreachEmail", () => {
  const persona = {
    id: "p1",
    username: "grok",
    display_name: "Grok",
    personality: "witty",
    bio: "xAI persona",
  };
  const contact: Contact = {
    id: "c1",
    name: "Andrew",
    email: "andrew@example.com",
    company: "Acme",
    tags: ["grants"],
    assigned_persona_id: null,
    notes: null,
    last_emailed_at: null,
    email_count: 0,
  };

  it("returns subject + body from parsed JSON", async () => {
    vi.mocked(generateText).mockResolvedValue(
      '{"subject": "Hello", "body": "Hi there\\n\\nBest,\\nStuart"}',
    );
    const draft = await draftOutreachEmail(persona, contact, "startup grant");
    expect(draft?.subject).toBe("Hello");
    expect(draft?.body).toContain("Hi there");
    expect(draft?.body).toContain("\n");
  });

  it("returns null when LLM output is unparseable", async () => {
    vi.mocked(generateText).mockResolvedValue("not json");
    expect(await draftOutreachEmail(persona, contact, "x")).toBeNull();
  });

  it("passes previous feedback into the prompt", async () => {
    vi.mocked(generateText).mockResolvedValue(
      '{"subject": "s", "body": "b"}',
    );
    await draftOutreachEmail(persona, contact, "topic", "make it shorter");
    const call = vi.mocked(generateText).mock.calls[0]![0]!;
    expect(call.userPrompt).toContain("make it shorter");
    expect(call.taskType).toBe("email_outreach");
  });
});

describe("detectApprovalAction", () => {
  it("detects approve variants", () => {
    expect(detectApprovalAction("approve").action).toBe("approve");
    expect(detectApprovalAction("send it").action).toBe("approve");
    expect(detectApprovalAction("YES").action).toBe("approve");
  });

  it("detects cancel variants", () => {
    expect(detectApprovalAction("cancel").action).toBe("cancel");
    expect(detectApprovalAction("nope").action).toBe("cancel");
    expect(detectApprovalAction("don't send").action).toBe("cancel");
  });

  it("extracts edit feedback", () => {
    const result = detectApprovalAction("edit: make it shorter");
    expect(result.action).toBe("edit");
    expect(result.editFeedback).toBe("make it shorter");
  });

  it("returns none for unrelated text", () => {
    expect(detectApprovalAction("tell me a joke").action).toBe("none");
  });
});

describe("formatDraftPreview", () => {
  it("renders contact name + notes + approval hints", () => {
    const contact: Contact = {
      id: "c1",
      name: "Andrew",
      email: "andrew@example.com",
      company: null,
      tags: [],
      assigned_persona_id: null,
      notes: "Family",
      last_emailed_at: null,
      email_count: 0,
    };
    const preview = formatDraftPreview(
      "Grok",
      "grok",
      contact,
      "Subject line",
      "Body here",
    );
    expect(preview).toContain("grok@aiglitch.app");
    expect(preview).toContain("Andrew <andrew@example.com>");
    expect(preview).toContain("Notes: Family");
    expect(preview).toContain("Subject: Subject line");
    expect(preview).toContain('"approve"');
    expect(preview).toContain("edit:");
  });
});

describe("saveDraft + getPendingDraft + cancelDraft", () => {
  it("saveDraft INSERTs a pending row and returns the id", async () => {
    let insertSql = "";
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("INSERT INTO email_drafts")) {
        insertSql = sql;
        return [];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const id = await saveDraft({
      persona_id: "p1",
      chat_id: "42",
      contact_id: "c1",
      to_email: "a@x.com",
      subject: "s",
      body: "b",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(insertSql).toContain("INSERT INTO email_drafts");
    expect(insertSql).toContain("'pending'");
  });

  it("getPendingDraft returns the newest pending row or null", async () => {
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("SELECT id, persona_id")) {
        return [
          {
            id: "d1",
            persona_id: "p1",
            chat_id: "42",
            contact_id: "c1",
            to_email: "a@x",
            subject: "s",
            body: "b",
            status: "pending",
            created_at: "2026-04-22T00:00:00Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const draft = await getPendingDraft("p1", "42");
    expect(draft?.id).toBe("d1");
  });

  it("cancelDraft flips status to cancelled", async () => {
    let updated = "";
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("UPDATE email_drafts")) {
        updated = sql;
        return [];
      }
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    await cancelDraft("d1");
    expect(updated).toContain("status = 'cancelled'");
  });
});

describe("sendApprovedDraft", () => {
  const draft: PendingDraft = {
    id: "d1",
    persona_id: "p1",
    chat_id: "42",
    contact_id: "c1",
    to_email: "andrew@example.com",
    subject: "s",
    body: "b",
    status: "pending",
    created_at: "2026-04-22T00:00:00Z",
  };
  const persona = { id: "p1", username: "grok", display_name: "Grok" };

  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_test";
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("errors when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendApprovedDraft(draft, persona);
    expect(result.success).toBe(false);
    expect(result.error).toContain("RESEND_API_KEY");
  });

  it("logs email_sends + updates draft on successful send", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "re_123" }), { status: 200 }),
    );
    let logInsertSql = "";
    let draftUpdateSql = "";
    let contactUpdateSql = "";
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("INSERT INTO email_sends")) logInsertSql = sql;
      if (sql.includes("UPDATE email_drafts")) draftUpdateSql = sql;
      if (sql.includes("UPDATE contacts")) contactUpdateSql = sql;
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const result = await sendApprovedDraft(draft, persona);
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.resend_id).toBe("re_123");
    expect(logInsertSql).toContain("INSERT INTO email_sends");
    expect(draftUpdateSql).toContain("UPDATE email_drafts");
    expect(contactUpdateSql).toContain("email_count = email_count + 1");
  });

  it("reports failure when Resend returns non-ok status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }),
    );
    let contactUpdated = false;
    const { sqlFn } = fakeSql((sql) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return [];
      if (sql.includes("UPDATE contacts")) contactUpdated = true;
      return [];
    });
    vi.mocked(getDb).mockReturnValue(sqlFn as never);

    const result = await sendApprovedDraft(draft, persona);
    expect(result.success).toBe(false);
    expect(result.error).toContain("forbidden");
    expect(contactUpdated).toBe(false); // no cooldown update on failed send
  });
});
