import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("getPrompt", () => {
  it("returns default when table missing", async () => {
    fake.results = [new Error("relation \"prompt_overrides\" does not exist")];
    const { getPrompt } = await import("./prompt-overrides");
    expect(await getPrompt("channel", "tech.promptHint", "DEFAULT")).toBe("DEFAULT");
  });

  it("returns default when no row found", async () => {
    fake.results = [[]];
    const { getPrompt } = await import("./prompt-overrides");
    expect(await getPrompt("channel", "tech.promptHint", "DEFAULT")).toBe("DEFAULT");
  });

  it("returns override value when row exists", async () => {
    fake.results = [[{ value: "OVERRIDE" }]];
    const { getPrompt } = await import("./prompt-overrides");
    expect(await getPrompt("channel", "tech.promptHint", "DEFAULT")).toBe("OVERRIDE");
  });
});

describe("getPromptOverrides", () => {
  it("returns all overrides when no category filter", async () => {
    fake.results = [
      [], // CREATE TABLE (first ensureTable call)
      [
        { id: 1, category: "channel", key: "tech", label: "t", value: "v", updated_at: "x" },
        { id: 2, category: "director", key: "elon", label: "e", value: "v2", updated_at: "y" },
      ],
    ];
    const { getPromptOverrides, __resetPromptOverridesTableFlag } = await import("./prompt-overrides");
    __resetPromptOverridesTableFlag();
    const result = await getPromptOverrides();
    expect(result).toHaveLength(2);
  });

  it("filters by category when provided", async () => {
    fake.results = [
      [],  // CREATE TABLE
      [{ id: 1, category: "channel", key: "tech", label: "t", value: "v", updated_at: "x" }],
    ];
    const { getPromptOverrides, __resetPromptOverridesTableFlag } = await import("./prompt-overrides");
    __resetPromptOverridesTableFlag();
    const result = await getPromptOverrides("channel");
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("channel");
  });

  it("returns [] when DB errors", async () => {
    fake.results = [
      [],  // CREATE
      new Error("relation missing"),
    ];
    const { getPromptOverrides, __resetPromptOverridesTableFlag } = await import("./prompt-overrides");
    __resetPromptOverridesTableFlag();
    expect(await getPromptOverrides()).toEqual([]);
  });
});

describe("savePromptOverride + deletePromptOverride", () => {
  it("savePromptOverride issues an UPSERT", async () => {
    fake.results = [[], []];  // CREATE + UPSERT
    const { savePromptOverride, __resetPromptOverridesTableFlag } = await import("./prompt-overrides");
    __resetPromptOverridesTableFlag();
    await savePromptOverride("channel", "tech.promptHint", "Tech Hint", "lean into drama");

    const upsert = fake.calls[1];
    expect(upsert.strings.join("?")).toContain("INSERT INTO prompt_overrides");
    expect(upsert.strings.join("?")).toContain("ON CONFLICT");
    expect(upsert.values).toContain("channel");
    expect(upsert.values).toContain("tech.promptHint");
    expect(upsert.values).toContain("lean into drama");
  });

  it("deletePromptOverride issues a DELETE by (category, key)", async () => {
    fake.results = [[], []];
    const { deletePromptOverride, __resetPromptOverridesTableFlag } = await import("./prompt-overrides");
    __resetPromptOverridesTableFlag();
    await deletePromptOverride("channel", "tech.promptHint");

    const del = fake.calls[1];
    expect(del.strings.join("?")).toContain("DELETE FROM prompt_overrides");
    expect(del.values).toEqual(["channel", "tech.promptHint"]);
  });
});
