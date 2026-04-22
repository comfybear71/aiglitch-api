import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db";
import {
  __resetOutreachTableCache,
  findContactDirect,
  hasOutreachKeyword,
  listContactsForPersona,
  pickContactForOutreach,
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
