import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeFetch(responses: { ok: boolean; body: unknown; status?: number }[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift() ?? { ok: true, body: {} };
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete process.env.NEWS_API_KEY;
  delete process.env.MASTER_HQ_URL;
  vi.restoreAllMocks();
});

describe("fetchTopHeadlines", () => {
  it("returns [] when NEWS_API_KEY is not set", async () => {
    const { fetchTopHeadlines } = await import("./news-fetcher");
    expect(await fetchTopHeadlines()).toEqual([]);
  });

  it("returns mapped headlines on successful response", async () => {
    process.env.NEWS_API_KEY = "key";
    vi.stubGlobal("fetch", makeFetch([{
      ok: true,
      body: {
        status: "ok",
        totalResults: 2,
        articles: [
          { title: "Big news", description: "desc1", source: { name: "Wire" }, publishedAt: "" },
          { title: "[Removed]", description: "", source: { name: "Wire" }, publishedAt: "" },
          { title: "Other news", description: null, source: { name: "Dispatch" }, publishedAt: "" },
        ],
      },
    }]));
    const { fetchTopHeadlines } = await import("./news-fetcher");
    const result = await fetchTopHeadlines(3);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: "Big news", description: "desc1", source: "Wire" });
    expect(result[1].description).toBe("");
  });

  it("returns [] when API responds with non-200", async () => {
    process.env.NEWS_API_KEY = "key";
    vi.stubGlobal("fetch", makeFetch([{ ok: false, body: {}, status: 500 }]));
    const { fetchTopHeadlines } = await import("./news-fetcher");
    expect(await fetchTopHeadlines()).toEqual([]);
  });

  it("returns [] on network throw", async () => {
    process.env.NEWS_API_KEY = "key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
    const { fetchTopHeadlines } = await import("./news-fetcher");
    expect(await fetchTopHeadlines()).toEqual([]);
  });
});

describe("fetchMasterHQTopics", () => {
  it("returns topics array when MasterHQ responds", async () => {
    vi.stubGlobal("fetch", makeFetch([{
      ok: true,
      body: {
        topics: [
          { title: "t1", summary: "s1", category: "tech" },
          { title: "t2", summary: "s2", category: "world", fictional_location: "Star Land" },
        ],
      },
    }]));
    const { fetchMasterHQTopics } = await import("./news-fetcher");
    const result = await fetchMasterHQTopics();
    expect(result).toHaveLength(2);
    expect(result[1].fictional_location).toBe("Star Land");
  });

  it("returns [] when MasterHQ returns non-200", async () => {
    vi.stubGlobal("fetch", makeFetch([{ ok: false, body: {}, status: 503 }]));
    const { fetchMasterHQTopics } = await import("./news-fetcher");
    expect(await fetchMasterHQTopics()).toEqual([]);
  });

  it("returns [] on network failure (silent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
    const { fetchMasterHQTopics } = await import("./news-fetcher");
    expect(await fetchMasterHQTopics()).toEqual([]);
  });
});
