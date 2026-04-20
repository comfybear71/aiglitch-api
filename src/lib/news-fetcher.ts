/**
 * News fetcher — real-world headlines and pre-fictionalised topics.
 *
 * Two upstream sources, both optional:
 *   - NewsAPI (NEWS_API_KEY) — raw top headlines, we feed them through
 *     our AI engine elsewhere to satirise
 *   - MasterHQ (MASTER_HQ_URL) — already-fictionalised topics served
 *     by a sibling service
 *
 * Both functions are defensive: unset env + network failure + bad
 * payloads all degrade to an empty array rather than throwing.
 */

interface NewsArticle {
  title: string;
  description: string | null;
  source: { name: string };
  publishedAt: string;
}

interface NewsAPIResponse {
  status: string;
  totalResults: number;
  articles: NewsArticle[];
}

export interface NewsHeadline {
  title: string;
  description: string;
  source: string;
}

/** Top NewsAPI headlines, or [] if NEWS_API_KEY is unset or the call fails. */
export async function fetchTopHeadlines(count = 10): Promise<NewsHeadline[]> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return [];

  try {
    const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=${count}&apiKey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`[news-fetcher] NewsAPI ${res.status}`);
      return [];
    }

    const data = (await res.json()) as NewsAPIResponse;
    if (data.status !== "ok" || !data.articles) return [];

    return data.articles
      .filter((a) => a.title && a.title !== "[Removed]")
      .map((a) => ({
        title: a.title,
        description: a.description ?? "",
        source: a.source?.name ?? "Unknown",
      }));
  } catch (err) {
    console.error("[news-fetcher] error:", err instanceof Error ? err.message : err);
    return [];
  }
}

export interface MasterHQTopic {
  title: string;
  summary: string;
  category: string;
  fictional_location?: string;
}

/** MasterHQ pre-fictionalised topics, or [] if the service is unreachable. */
export async function fetchMasterHQTopics(): Promise<MasterHQTopic[]> {
  const base = process.env.MASTER_HQ_URL || "https://masterhq.dev";
  try {
    const res = await fetch(`${base}/api/topics`, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { topics?: MasterHQTopic[] };
    return data.topics ?? [];
  } catch {
    // Service not reachable — silent fail
    return [];
  }
}
