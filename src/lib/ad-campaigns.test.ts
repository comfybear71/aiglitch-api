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

describe("getActiveCampaigns", () => {
  it("returns all active campaigns when no channelId is given", async () => {
    const campaigns = [
      { id: "c1", brand_name: "Acme", target_channels: null },
      { id: "c2", brand_name: "Beta", target_channels: null },
    ];
    fake.results = [campaigns];
    const { getActiveCampaigns } = await import("./ad-campaigns");
    const result = await getActiveCampaigns();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("filters to campaigns targeting the given channel", async () => {
    fake.results = [[
      { id: "c1", brand_name: "Acme", target_channels: '["channel-1","channel-2"]' },
      { id: "c2", brand_name: "Beta", target_channels: '["channel-3"]' },
      { id: "c3", brand_name: "Gamma", target_channels: null }, // null = all channels
    ]];
    const { getActiveCampaigns } = await import("./ad-campaigns");
    const result = await getActiveCampaigns("channel-1");
    expect(result.map((c) => c.id).sort()).toEqual(["c1", "c3"]);
  });

  it("returns empty array when query fails (e.g. missing table)", async () => {
    fake.results = [new Error("relation \"ad_campaigns\" does not exist")];
    const { getActiveCampaigns } = await import("./ad-campaigns");
    const result = await getActiveCampaigns();
    expect(result).toEqual([]);
  });
});

describe("expireCompletedCampaigns", () => {
  it("returns 0 and skips UPDATE when nothing is past-due", async () => {
    fake.results = [[{ c: 0 }]];
    const { expireCompletedCampaigns } = await import("./ad-campaigns");
    const count = await expireCompletedCampaigns();
    expect(count).toBe(0);
    expect(fake.calls).toHaveLength(1); // only the count SELECT
  });

  it("flips past-due actives to completed and returns the count", async () => {
    fake.results = [
      [{ c: 3 }],  // SELECT past-due count
      [],          // UPDATE
    ];
    const { expireCompletedCampaigns } = await import("./ad-campaigns");
    const count = await expireCompletedCampaigns();
    expect(count).toBe(3);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].strings.join("?")).toContain("UPDATE ad_campaigns");
  });

  it("returns 0 when ad_campaigns is missing (table does not exist)", async () => {
    fake.results = [new Error("relation \"ad_campaigns\" does not exist")];
    const { expireCompletedCampaigns } = await import("./ad-campaigns");
    expect(await expireCompletedCampaigns()).toBe(0);
  });
});
