import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
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

describe("getSetting", () => {
  it("returns null when the row is missing", async () => {
    fake.results = [[]];
    const { getSetting } = await import("./settings");
    expect(await getSetting("nope")).toBeNull();
  });

  it("returns the stored value string", async () => {
    fake.results = [[{ value: "true" }]];
    const { getSetting } = await import("./settings");
    expect(await getSetting("voice_disabled")).toBe("true");
  });

  it("caches subsequent reads (only one SQL call for the same key)", async () => {
    fake.results = [[{ value: "42" }]];
    const { getSetting } = await import("./settings");
    await getSetting("throttle");
    await getSetting("throttle");
    expect(fake.calls.length).toBe(1);
  });
});

describe("setSetting", () => {
  it("issues an UPSERT and busts the cache", async () => {
    // First getSetting populates cache
    fake.results = [[{ value: "old" }], [], [{ value: "new" }]];
    const { getSetting, setSetting } = await import("./settings");

    expect(await getSetting("k")).toBe("old");
    expect(fake.calls.length).toBe(1);

    await setSetting("k", "new"); // fires UPSERT (2nd call), busts cache

    // Next getSetting should hit DB again (3rd call)
    expect(await getSetting("k")).toBe("new");
    expect(fake.calls.length).toBe(3);
  });
});
