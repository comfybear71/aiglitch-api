import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake = {
  calls: [] as { strings: TemplateStringsArray; values: unknown[] }[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
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

describe("prompt-library", () => {
  it("rejects unknown collections via isPromptLibraryCollection", async () => {
    const { isPromptLibraryCollection } = await import("./prompt-library");
    expect(isPromptLibraryCollection("elon")).toBe(true);
    expect(isPromptLibraryCollection("ad")).toBe(true);
    expect(isPromptLibraryCollection("nope")).toBe(false);
  });

  it("listPromptLibrary maps preview + stale", async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    fake.results = [
      [], // CREATE TABLE
      [], // CREATE INDEX
      [
        {
          id: "d1",
          collection: "elon",
          title: "Day 130 fun",
          value: "A".repeat(200),
          created_at: old,
          updated_at: old,
        },
      ],
    ];
    const { listPromptLibrary, __resetPromptLibraryTableFlag } = await import(
      "./prompt-library"
    );
    __resetPromptLibraryTableFlag();
    const drafts = await listPromptLibrary("elon");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.stale).toBe(true);
    expect(drafts[0]!.preview.length).toBeLessThanOrEqual(120);
    expect(drafts[0]!.title).toBe("Day 130 fun");
  });

  it("savePromptLibraryDraft inserts then reads back", async () => {
    const now = new Date().toISOString();
    fake.results = [
      [], // CREATE TABLE
      [], // CREATE INDEX
      [], // INSERT
      [
        {
          id: "saved-id",
          collection: "ad",
          title: "My ad",
          value: "neon chaos",
          meta: { style: "cyber" },
          created_at: now,
          updated_at: now,
        },
      ],
    ];
    // Force known id by mocking randomUUID? save uses randomUUID — readback uses whatever INSERT used.
    // We simulate get after insert returning fixed id from SELECT.
    const { savePromptLibraryDraft, __resetPromptLibraryTableFlag } = await import(
      "./prompt-library"
    );
    __resetPromptLibraryTableFlag();
    const draft = await savePromptLibraryDraft({
      collection: "ad",
      title: "My ad",
      value: "neon chaos",
      meta: { style: "cyber" },
    });
    expect(draft.value).toBe("neon chaos");
    expect(draft.collection).toBe("ad");
    expect(fake.calls.some((c) => c.strings.join("").includes("INSERT INTO prompt_library"))).toBe(
      true,
    );
  });
});
