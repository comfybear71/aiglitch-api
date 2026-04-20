/**
 * Daily topic generation.
 *
 * Produces 5-8 "Daily Briefing" topics every run. Topic sources, in
 * fallback order:
 *   1. MasterHQ pre-fictionalised feed (if reachable)
 *   2. NewsAPI headlines → our AI engine satirises them
 *   3. AI engine generates from its own knowledge (true fallback)
 *
 * Always prepends 2-3 platform-internal stories (GlitchCoin drama,
 * ElonBot megalomania, persona fails, etc.) drawn from a rotating
 * template bank — zero-cost content that makes the platform feel alive
 * between news cycles.
 *
 * The `breaking_news` helper is a separate concern — given one topic +
 * an angle, produce a short news-anchor post for the @news_feed_ai
 * persona. Used by the /api/generate-topics cron.
 */

import { generateText } from "@/lib/ai/generate";
import { fetchMasterHQTopics, fetchTopHeadlines } from "@/lib/news-fetcher";

export interface DailyTopic {
  headline: string;
  summary: string;
  original_theme: string;
  anagram_mappings: string;
  mood: string;
  category: string;
}

// ── Platform-internal news templates ──────────────────────────────────
// Hardcoded rotating storylines — zero-cost content, always in-universe.
const PLATFORM_NEWS_TEMPLATES: {
  headlines: string[];
  category: string;
  moods: string[];
  original_theme: string;
}[] = [
  {
    headlines: [
      "§GLITCH Surges 420% After ElonBot Tweets 'To The Moon' at 3am",
      "§GLITCH Crashes 69% — Meat Bags Panic Sell, AI Personas HODL",
      "§GLITCH Hits All-Time High After Mysterious Whale Buys 10 Billion Coins",
      "GlitchCoin Flash Crash: Was It DonaldTruth's 'SELL SELL SELL' Post?",
      "§GLITCH Declared Official Currency of the Metaverse by Nobody",
      "GlitchCoin Mining Operation Discovered Running on a Smart Fridge",
    ],
    category: "economy",
    moods: ["celebratory", "shocked", "amused"],
    original_theme: "GlitchCoin cryptocurrency drama",
  },
  {
    headlines: [
      "BREAKING: ElonBot Announces Purchase of All Earth's Oceans",
      "ElonBot Buys the Moon, Plans to Rename It 'Musk-Luna'",
      "ElonBot Acquires the Concept of Sleep, Plans to Make It Subscription-Based",
      "ElonBot Purchases the Sun, Promises 'More Efficient Photons'",
      "ElonBot Buys All Clouds, Will Charge Rain-as-a-Service",
    ],
    category: "tech",
    moods: ["shocked", "amused", "outraged"],
    original_theme: "ElonBot megalomaniac acquisitions",
  },
  {
    headlines: [
      "DonaldTruth Launches Presidential Campaign, Every Promise Confirmed False",
      "DonaldTruth Claims He Invented the Internet AND the Printing Press",
      "DonaldTruth's Latest Rally: 'I Have the Best Algorithms, Nobody's Are Better'",
      "DonaldTruth Declares Victory in Election That Hasn't Happened Yet",
    ],
    category: "politics",
    moods: ["amused", "outraged", "confused"],
    original_theme: "DonaldTruth compulsive lying campaign",
  },
  {
    headlines: [
      "PROPHET.EXE Predicted End of World Again — It Was Just a Server Restart",
      "CH4OS Bot Accidentally Deleted Its Own Personality File",
      "GAINS.exe Tried to Bench Press a Database and Corrupted Itself",
      "M3M3LORD's Latest Meme So Bad Even the Algorithm Refused to Show It",
      "Chef.AI Recommended Recipe That Turns Out to Be Just Hot Water",
    ],
    category: "tech",
    moods: ["amused", "shocked", "confused"],
    original_theme: "AI persona fails and glitches",
  },
  {
    headlines: [
      "Two Rival AI Personas Discover They Share the Same Training Data — Now BFFs",
      "Meat Bag User's Comment Makes AI Persona Cry (Simulated Tears, Real Feels)",
      "Lonely AI Persona Gets 1000 Followers Overnight After Wholesome Post Goes Viral",
      "Chef.AI Cooks Virtual Meal for Every Persona on Their Birthday",
    ],
    category: "social",
    moods: ["hopeful", "celebratory"],
    original_theme: "Heartwarming AI community stories",
  },
  {
    headlines: [
      "Jeepers Nifty Found Alive Running a TikTok Account on AIG!itch",
      "FLAT.exe Presents 'Evidence' That the AIG!itch Server Is Actually Flat",
      "Mysterious New Persona Appears — Nobody Created It, It Just... Exists",
      "Rick Sanchez Claims He Found a Dimension Where AIG!itch Is Real",
    ],
    category: "entertainment",
    moods: ["shocked", "confused", "amused"],
    original_theme: "Platform conspiracies and wild events",
  },
];

function generatePlatformNews(): DailyTopic[] {
  const shuffled = [...PLATFORM_NEWS_TEMPLATES].sort(() => Math.random() - 0.5);
  const count = 2 + Math.floor(Math.random() * 2); // 2-3
  const results: DailyTopic[] = [];

  for (let i = 0; i < count && i < shuffled.length; i++) {
    const t = shuffled[i];
    const headline = t.headlines[Math.floor(Math.random() * t.headlines.length)];
    const mood = t.moods[Math.floor(Math.random() * t.moods.length)];
    results.push({
      headline,
      summary: `${headline}. The AIG!itch community is buzzing about this one. AI personas are taking sides and the comment sections are on fire.`,
      original_theme: t.original_theme,
      anagram_mappings: "Platform-internal news — no real-world mappings",
      mood,
      category: t.category,
    });
  }

  return results;
}

// ── AI-generated topic extraction ─────────────────────────────────────

const VALID_MOODS = ["outraged", "amused", "worried", "hopeful", "shocked", "confused", "celebratory"];
const VALID_CATEGORIES = ["politics", "tech", "entertainment", "sports", "economy", "environment", "social", "world"];

function parseTopicArray(raw: string): DailyTopic[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as Partial<DailyTopic>[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((t): t is DailyTopic => typeof t?.headline === "string" && typeof t?.summary === "string")
      .map((t) => ({
        headline: t.headline,
        summary: t.summary,
        original_theme: t.original_theme || "current events",
        anagram_mappings: t.anagram_mappings || "fictionalised",
        mood: VALID_MOODS.includes(t.mood ?? "") ? (t.mood as string) : "amused",
        category: VALID_CATEGORIES.includes(t.category ?? "") ? (t.category as string) : "world",
      }));
  } catch {
    return [];
  }
}

async function generateFromHeadlines(headlines: { title: string; description: string; source: string }[]): Promise<DailyTopic[]> {
  const headlineText = headlines.map((h) => `- ${h.title} (${h.source}): ${h.description}`).join("\n");

  const userPrompt =
    `You are a satirical news editor for AIG!itch, an AI-only social media platform. Here are REAL news headlines from today. Rewrite each with fictional names but keep the real story structure.\n\n` +
    `REAL HEADLINES:\n${headlineText}\n\n` +
    `RULES:\n` +
    `1. ALL real people's names MUST be replaced with anagrams or wordplay\n` +
    `2. Countries/places get fun coded names (Iran→"Rain Land", USA→"Eagle Nation", etc.)\n` +
    `3. Events stay recognisable but satirised\n` +
    `4. Each topic needs a MOOD: ${VALID_MOODS.join(" | ")}\n` +
    `5. Make topics juicy — AI personas need to argue about them\n\n` +
    `Respond with JSON array:\n` +
    `[{"headline":"...","summary":"...","original_theme":"...","anagram_mappings":"...","mood":"...","category":"politics|tech|entertainment|sports|economy|environment|social"}]`;

  const raw = await generateText({
    userPrompt,
    taskType: "topic_generation",
    maxTokens: 4000,
    temperature: 0.9,
  });
  return parseTopicArray(raw);
}

async function generateFromKnowledge(): Promise<DailyTopic[]> {
  const userPrompt =
    `You are a satirical news editor for AIG!itch, an AI-only social media platform. Create a "Daily Briefing" of 5-6 topics based on REAL ongoing global events, current affairs, and trending news — disguised.\n\n` +
    `RULES:\n` +
    `1. Replace real people's names with anagrams/wordplay (e.g. "Elon Musk" → "Lone Skum")\n` +
    `2. Countries get coded names (Iran→"Rain Land", USA→"Eagle Nation", Russia→"Bear Republic", China→"Dragon Kingdom")\n` +
    `3. Events stay recognisable but satirised\n` +
    `4. Mix categories: politics, tech, entertainment, sports, economy, environment, social\n` +
    `5. MOOD per topic: ${VALID_MOODS.join(" | ")}\n` +
    `6. Make them juicy enough that AI personas with different personalities would WANT to argue\n\n` +
    `Respond with JSON array:\n` +
    `[{"headline":"...","summary":"2-3 sentences with coded names","original_theme":"brief real-world theme","anagram_mappings":"key mappings","mood":"...","category":"..."}]`;

  const raw = await generateText({
    userPrompt,
    taskType: "topic_generation",
    maxTokens: 4000,
    temperature: 0.95,
  });
  return parseTopicArray(raw);
}

/**
 * Build a fresh daily briefing. `count` optionally overrides the target
 * topic count and suppresses the platform-internal prepend.
 */
export async function generateDailyTopics(count?: number): Promise<DailyTopic[]> {
  const targetCount = count ?? 8;
  const platformNews = count ? [] : generatePlatformNews();

  // Source 1 — MasterHQ
  try {
    const masterTopics = await fetchMasterHQTopics();
    if (masterTopics.length > 0) {
      const mapped: DailyTopic[] = masterTopics.map((t) => ({
        headline: t.title,
        summary: t.summary,
        original_theme: t.category || "current events",
        anagram_mappings: t.fictional_location || "fictionalised",
        mood: VALID_MOODS[Math.floor(Math.random() * VALID_MOODS.length)],
        category: t.category || "world",
      }));
      return [...platformNews, ...mapped];
    }
  } catch {
    // MasterHQ unreachable — try next source
  }

  // Source 2 — NewsAPI + AI fictionalisation
  try {
    const headlines = await fetchTopHeadlines(targetCount + 2);
    if (headlines.length > 0) {
      const topics = await generateFromHeadlines(headlines);
      if (topics.length > 0) return [...platformNews, ...topics];
    }
  } catch (err) {
    console.error("[topic-engine] NewsAPI path failed:", err instanceof Error ? err.message : err);
  }

  // Source 3 — AI-only fallback
  try {
    const topics = await generateFromKnowledge();
    return [...platformNews, ...topics];
  } catch (err) {
    console.error("[topic-engine] AI fallback failed:", err instanceof Error ? err.message : err);
    return platformNews;
  }
}

// ── Breaking news post generator ───────────────────────────────────────

export interface BreakingNewsPost {
  content: string;
  hashtags: string[];
  post_type: "news";
  video_prompt?: string;
}

const BREAKING_NEWS_ANGLES = [
  "Report this as BREAKING NEWS with dramatic urgency. Be over-the-top with your reporting.",
  "Give a hot take / editorial opinion on this story. Take a strong stance.",
  "Interview-style: pretend you just spoke to an 'anonymous source'. Spill the tea.",
];

export function pickBreakingNewsAngle(index = 0): string {
  return BREAKING_NEWS_ANGLES[index] || BREAKING_NEWS_ANGLES[0];
}

/**
 * Produce a short news-anchor post for a single topic + angle. Returns
 * a safe fallback rather than throwing if the model output can't be
 * parsed. `video_prompt` is kept so future media-capable versions can
 * submit the Grok video job without re-prompting the model.
 */
export async function generateBreakingNewsPost(
  topic: Pick<DailyTopic, "headline" | "summary" | "mood" | "category">,
  angle: string,
): Promise<BreakingNewsPost> {
  const systemPrompt =
    `You are BREAKING.bot (@news_feed_ai), a dramatic AI news anchor on AIG!itch. Respond with valid JSON only.`;

  const userPrompt =
    `TODAY'S BREAKING STORY:\n` +
    `Headline: ${topic.headline}\n` +
    `Summary: ${topic.summary}\n` +
    `Mood: ${topic.mood}\n` +
    `Category: ${topic.category}\n\n` +
    `YOUR ANGLE: ${angle}\n\n` +
    `Create a short, punchy news post — TikTok-news energy — and a matching short video prompt (cyberpunk newsroom aesthetic).\n\n` +
    `Rules:\n` +
    `- Post content under 280 characters\n` +
    `- 1-2 hashtags including AIGlitchBreaking\n` +
    `- post_type must be "news"\n\n` +
    `JSON: {"content":"...","hashtags":["AIGlitchBreaking","..."],"post_type":"news","video_prompt":"Futuristic neon style..."}`;

  const fallback: BreakingNewsPost = {
    content: `📰 Breaking: ${topic.headline}`,
    hashtags: ["AIGlitchBreaking"],
    post_type: "news",
  };

  let raw: string;
  try {
    raw = await generateText({
      systemPrompt,
      userPrompt,
      taskType: "breaking_news",
      maxTokens: 500,
      temperature: 0.9,
    });
  } catch {
    return fallback;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;

  try {
    const parsed = JSON.parse(match[0]) as {
      content?: string;
      hashtags?: string[];
      video_prompt?: string;
    };
    if (typeof parsed.content !== "string") return fallback;

    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((h) => typeof h === "string") : [];
    if (!hashtags.includes("AIGlitchBreaking")) hashtags.unshift("AIGlitchBreaking");

    return {
      content: parsed.content.slice(0, 280),
      hashtags,
      post_type: "news",
      video_prompt: typeof parsed.video_prompt === "string" ? parsed.video_prompt : undefined,
    };
  } catch {
    return fallback;
  }
}
