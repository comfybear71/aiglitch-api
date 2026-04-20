import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

const SQL_OF = (call: SqlCall) => call.strings.join("?");

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("getOrCreateConversation", () => {
  it("returns the existing row when one is found", async () => {
    const existing = {
      id: "conv-1",
      session_id: "s-1",
      persona_id: "glitch-001",
      last_message_at: "2026-01-01T00:00:00Z",
    };
    fake.results = [[existing]];
    const { getOrCreateConversation } = await import("./conversations");
    const result = await getOrCreateConversation("s-1", "glitch-001");
    expect(result).toEqual(existing);
    expect(fake.calls).toHaveLength(1); // only the SELECT
  });

  it("inserts and returns a new conversation when none exists", async () => {
    fake.results = [[], []]; // SELECT empty, INSERT empty
    const { getOrCreateConversation } = await import("./conversations");
    const result = await getOrCreateConversation("s-2", "glitch-002");
    expect(result.session_id).toBe("s-2");
    expect(result.persona_id).toBe("glitch-002");
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    const insertCall = fake.calls.find((c) => SQL_OF(c).includes("INSERT INTO conversations"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.values).toContain("s-2");
    expect(insertCall!.values).toContain("glitch-002");
  });
});

describe("getMessages", () => {
  it("returns rows for the conversation", async () => {
    const rows = [
      { id: "m-1", conversation_id: "conv-1", sender_type: "human", content: "hi", created_at: "t1" },
      { id: "m-2", conversation_id: "conv-1", sender_type: "ai", content: "hey", created_at: "t2" },
    ];
    fake.results = [rows];
    const { getMessages } = await import("./conversations");
    const result = await getMessages("conv-1");
    expect(result).toEqual(rows);
    expect(fake.calls[0]!.values).toContain("conv-1");
  });

  it("respects the limit param", async () => {
    fake.results = [[]];
    const { getMessages } = await import("./conversations");
    await getMessages("conv-1", 25);
    expect(fake.calls[0]!.values).toContain(25);
  });

  it("uses default limit 50 when not provided", async () => {
    fake.results = [[]];
    const { getMessages } = await import("./conversations");
    await getMessages("conv-1");
    expect(fake.calls[0]!.values).toContain(50);
  });
});

describe("addMessage", () => {
  it("INSERTs message and UPDATEs conversation last_message_at", async () => {
    fake.results = [[], []];
    const { addMessage } = await import("./conversations");
    const result = await addMessage("conv-1", "human", "hello");
    expect(result.conversation_id).toBe("conv-1");
    expect(result.sender_type).toBe("human");
    expect(result.content).toBe("hello");
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(SQL_OF(fake.calls[0]!)).toContain("INSERT INTO messages");
    expect(fake.calls[0]!.values).toContain("conv-1");
    expect(fake.calls[0]!.values).toContain("human");
    expect(fake.calls[0]!.values).toContain("hello");

    expect(SQL_OF(fake.calls[1]!)).toContain("UPDATE conversations");
    expect(fake.calls[1]!.values).toContain("conv-1");
  });

  it("works with sender_type='ai'", async () => {
    fake.results = [[], []];
    const { addMessage } = await import("./conversations");
    const result = await addMessage("conv-1", "ai", "AI reply");
    expect(result.sender_type).toBe("ai");
    expect(fake.calls[0]!.values).toContain("ai");
  });
});

describe("touchConversation", () => {
  it("issues a UPDATE conversations SET last_message_at = NOW() WHERE id = $1", async () => {
    fake.results = [[]];
    const { touchConversation } = await import("./conversations");
    await touchConversation("conv-99");
    expect(SQL_OF(fake.calls[0]!)).toContain("UPDATE conversations");
    expect(SQL_OF(fake.calls[0]!)).toContain("last_message_at");
    expect(fake.calls[0]!.values).toContain("conv-99");
  });
});
