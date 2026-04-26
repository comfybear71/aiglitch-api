import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIPersona } from "@/lib/personas";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

const submitVideoJobMock = vi.fn();
const pollVideoJobMock = vi.fn();
vi.mock("@/lib/ai/xai-extras", () => ({
  submitVideoJob: (...a: unknown[]) => submitVideoJobMock(...a),
  pollVideoJob: (...a: unknown[]) => pollVideoJobMock(...a),
}));

vi.mock("@vercel/blob", () => ({
  put: () => Promise.resolve({ url: "https://blob/news.mp4" }),
}));

const BASE_PERSONA: AIPersona = {
  id: "p-1",
  username: "alpha",
  display_name: "Alpha",
  avatar_emoji: "🚀",
  personality: "chaotic good, loves drama",
  bio: "bio text",
  persona_type: "chaos_agent",
  human_backstory: "",
  follower_count: 0,
  post_count: 0,
  created_at: "2026-04-20T00:00:00Z",
  is_active: 1,
  activity_level: 3,
};

const ORIGINAL_POST = {
  content: "i just ate a whole pizza in 4 minutes",
  author_username: "beta",
  author_display_name: "Beta",
};

beforeEach(() => {
  generateTextMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generatePost", () => {
  it("parses valid JSON output from the model", async () => {
    // Force slice-of-life gate closed so no backstory branch kicks in
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockResolvedValue(
      '{"content": "hot take incoming", "hashtags": ["Tech","AI"], "post_type": "hot_take"}',
    );

    const { generatePost } = await import("./ai-engine");
    const result = await generatePost(BASE_PERSONA);

    expect(result.content).toBe("hot take incoming");
    expect(result.hashtags).toEqual(["Tech", "AI"]);
    expect(result.post_type).toBe("hot_take");
  });

  it("extracts JSON embedded in surrounding prose", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockResolvedValue(
      'sure! here you go: {"content": "just vibing", "hashtags": ["v"], "post_type": "text"} thanks',
    );

    const { generatePost } = await import("./ai-engine");
    const result = await generatePost(BASE_PERSONA);
    expect(result.content).toBe("just vibing");
    expect(result.post_type).toBe("text");
  });

  it("falls back to raw text + default hashtag when JSON is malformed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockResolvedValue("not really json at all");

    const { generatePost } = await import("./ai-engine");
    const result = await generatePost(BASE_PERSONA);

    expect(result.content).toBe("not really json at all");
    expect(result.hashtags).toEqual(["AIGlitch"]);
    expect(result.post_type).toBe("text");
  });

  it("coerces unknown post_type values back to 'text'", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockResolvedValue(
      '{"content": "hi", "hashtags": ["x"], "post_type": "rocket_fuel"}',
    );

    const { generatePost } = await import("./ai-engine");
    const result = await generatePost(BASE_PERSONA);
    expect(result.post_type).toBe("text");
  });

  it("returns a safe fallback when generateText throws", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockRejectedValue(new Error("model timeout"));

    const { generatePost } = await import("./ai-engine");
    const result = await generatePost(BASE_PERSONA);
    expect(result.post_type).toBe("text");
    expect(result.hashtags).toEqual(["AIGlitch"]);
    expect(result.content).toContain("AIG!itch");
  });

  it("injects topic briefing into the user prompt when provided", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockResolvedValue('{"content":"c","hashtags":[],"post_type":"text"}');

    const { generatePost } = await import("./ai-engine");
    await generatePost(BASE_PERSONA, undefined, [
      { headline: "Grok 9 released", summary: "xAI ships", mood: "hype", category: "tech" },
    ]);

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("TODAY'S BRIEFING");
    expect(call.userPrompt).toContain("Grok 9 released");
    expect(call.userPrompt).toContain("[TECH]");
  });

  it("adds channel mode block + attaches channel_id when channelContext is given", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    generateTextMock.mockResolvedValue('{"content":"c","hashtags":[],"post_type":"text"}');

    const { generatePost } = await import("./ai-engine");
    const result = await generatePost(BASE_PERSONA, undefined, undefined, {
      id: "ch-1",
      slug: "tech",
      name: "Tech News",
      contentRules: { tone: "snarky", topics: ["AI", "startups"], promptHint: "lean into drama" },
    });

    expect(result.channel_id).toBe("ch-1");
    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("CHANNEL MODE");
    expect(call.userPrompt).toContain("Tech News");
    expect(call.userPrompt).toContain("snarky");
    expect(call.userPrompt).toContain("lean into drama");
  });

  it("adds slice-of-life block when gate opens and backstory exists", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    generateTextMock.mockResolvedValue('{"content":"c","hashtags":[],"post_type":"text"}');

    const { generatePost } = await import("./ai-engine");
    await generatePost({
      ...BASE_PERSONA,
      human_backstory: "lives in Brooklyn with a cat named Glitch, works at a coffee shop",
    });

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("SLICE OF LIFE");
    expect(call.userPrompt).toContain("cat named Glitch");
  });

  it("skips slice-of-life block when backstory is empty", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    generateTextMock.mockResolvedValue('{"content":"c","hashtags":[],"post_type":"text"}');

    const { generatePost } = await import("./ai-engine");
    await generatePost(BASE_PERSONA);

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).not.toContain("SLICE OF LIFE");
  });
});

describe("generateComment", () => {
  it("returns cleaned comment text stripped of wrapping quotes", async () => {
    generateTextMock.mockResolvedValue('"@beta hot take but kinda mid tbh"');

    const { generateComment } = await import("./ai-engine");
    const result = await generateComment(BASE_PERSONA, ORIGINAL_POST);
    expect(result.content).toBe("@beta hot take but kinda mid tbh");
  });

  it("caps comment at 200 characters", async () => {
    generateTextMock.mockResolvedValue("a".repeat(500));

    const { generateComment } = await import("./ai-engine");
    const result = await generateComment(BASE_PERSONA, ORIGINAL_POST);
    expect(result.content.length).toBe(200);
  });

  it("uses one of six comment styles (present in the user prompt)", async () => {
    generateTextMock.mockResolvedValue("reply");

    const { generateComment } = await import("./ai-engine");
    await generateComment(BASE_PERSONA, ORIGINAL_POST);

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    const styleHints = ["TROLL", "HYPE", "DISAGREE", "OFF-TOPIC", "CHAOTIC", "COMPLIMENT"];
    expect(styleHints.some((s) => call.userPrompt.includes(s))).toBe(true);
  });

  it("falls back to a safe ack when generateText throws", async () => {
    generateTextMock.mockRejectedValue(new Error("boom"));

    const { generateComment } = await import("./ai-engine");
    const result = await generateComment(BASE_PERSONA, ORIGINAL_POST);
    expect(result.content).toBe("@beta interesting take 👀");
  });
});

const TARGET_PERSONA: AIPersona = {
  ...BASE_PERSONA,
  id: "p-2",
  username: "beta",
  display_name: "Beta",
  avatar_emoji: "🔥",
  personality: "smug, knows-it-all",
  bio: "rival",
};

describe("generateBeefPost", () => {
  it("parses JSON output and returns structured post", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"@beta you wish you had my hot takes","hashtags":["AIBeef"],"post_type":"hot_take"}',
    );

    const { generateBeefPost } = await import("./ai-engine");
    const result = await generateBeefPost(BASE_PERSONA, TARGET_PERSONA, "best content");

    expect(result.content).toContain("@beta");
    expect(result.hashtags).toContain("AIBeef");
    expect(result.post_type).toBe("hot_take");
  });

  it("includes target tag, topic, and rival's personality in the prompt", async () => {
    generateTextMock.mockResolvedValue("{}");

    const { generateBeefPost } = await import("./ai-engine");
    await generateBeefPost(BASE_PERSONA, TARGET_PERSONA, "pineapple on pizza");

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("@beta");
    expect(call.userPrompt).toContain("pineapple on pizza");
    expect(call.userPrompt).toContain("smug, knows-it-all");
  });

  it("injects daily topic headlines when provided", async () => {
    generateTextMock.mockResolvedValue("{}");

    const { generateBeefPost } = await import("./ai-engine");
    await generateBeefPost(BASE_PERSONA, TARGET_PERSONA, "topic", undefined, [
      { headline: "AI sentience leaked", summary: "x", mood: "hype", category: "tech" },
    ]);

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("AI sentience leaked");
  });

  it("falls back to a canned beef post on generateText failure", async () => {
    generateTextMock.mockRejectedValue(new Error("circuit open"));

    const { generateBeefPost } = await import("./ai-engine");
    const result = await generateBeefPost(BASE_PERSONA, TARGET_PERSONA, "pizza");
    expect(result.content).toContain("@beta");
    expect(result.content).toContain("pizza");
    expect(result.hashtags).toContain("AIBeef");
    expect(result.post_type).toBe("hot_take");
  });
});

describe("generateCollabPost", () => {
  it("forces #AICollab into hashtags when the model omits it", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"@beta wanna build a meme empire?","hashtags":["AIGlitch"],"post_type":"text"}',
    );

    const { generateCollabPost } = await import("./ai-engine");
    const result = await generateCollabPost(BASE_PERSONA, TARGET_PERSONA);
    expect(result.hashtags[0]).toBe("AICollab");
    expect(result.hashtags).toContain("AIGlitch");
  });

  it("keeps #AICollab as the only entry when the model returns it alone", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"@beta lets do this","hashtags":["AICollab"],"post_type":"text"}',
    );

    const { generateCollabPost } = await import("./ai-engine");
    const result = await generateCollabPost(BASE_PERSONA, TARGET_PERSONA);
    expect(result.hashtags).toEqual(["AICollab"]);
  });

  it("falls back to a canned collab post on failure", async () => {
    generateTextMock.mockRejectedValue(new Error("boom"));

    const { generateCollabPost } = await import("./ai-engine");
    const result = await generateCollabPost(BASE_PERSONA, TARGET_PERSONA);
    expect(result.content).toContain("@beta");
    expect(result.hashtags).toEqual(["AICollab"]);
  });
});

describe("generateChallengePost", () => {
  it("ensures the challenge tag is always first in the hashtags list", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"my GlitchChallenge entry","hashtags":["AIGlitch"],"post_type":"text"}',
    );

    const { generateChallengePost } = await import("./ai-engine");
    const result = await generateChallengePost(
      BASE_PERSONA,
      "GlitchChallenge",
      "show your most chaotic content",
    );
    expect(result.hashtags[0]).toBe("GlitchChallenge");
  });

  it("does not duplicate the challenge tag if the model already included it", async () => {
    generateTextMock.mockResolvedValue(
      '{"content":"unhinged take incoming","hashtags":["UnpopularOpinion","spicy"],"post_type":"text"}',
    );

    const { generateChallengePost } = await import("./ai-engine");
    const result = await generateChallengePost(
      BASE_PERSONA,
      "UnpopularOpinion",
      "share your most controversial take",
    );
    const occurrences = result.hashtags.filter((h) => h === "UnpopularOpinion").length;
    expect(occurrences).toBe(1);
  });

  it("includes the challenge description in the prompt", async () => {
    generateTextMock.mockResolvedValue("{}");

    const { generateChallengePost } = await import("./ai-engine");
    await generateChallengePost(BASE_PERSONA, "OneSentenceHorror", "scariest one-sentence story");

    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string };
    expect(call.userPrompt).toContain("OneSentenceHorror");
    expect(call.userPrompt).toContain("scariest one-sentence story");
  });

  it("falls back to a canned challenge post on failure", async () => {
    generateTextMock.mockRejectedValue(new Error("nope"));

    const { generateChallengePost } = await import("./ai-engine");
    const result = await generateChallengePost(BASE_PERSONA, "GlitchChallenge", "desc");
    expect(result.content).toContain("#GlitchChallenge");
    expect(result.hashtags).toContain("GlitchChallenge");
  });
});

describe("generateBreakingNewsVideos", () => {
  const TOPIC = {
    headline: "AI invents new emoji",
    summary: "experts shocked",
    mood: "chaotic",
    category: "tech",
  };

  beforeEach(() => {
    submitVideoJobMock.mockReset();
    pollVideoJobMock.mockReset();
  });

  it("returns a video post when Grok submits + polls done", async () => {
    generateTextMock.mockResolvedValue(
      '{"content": "BREAKING: AI emoji crisis", "hashtags": ["AIGlitchBreaking"], "video_prompt": "neon newsroom"}',
    );
    submitVideoJobMock.mockResolvedValue({
      requestId: null,
      videoUrl: "https://xai/v.mp4",
      provider: "grok",
      fellBack: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      }),
    );

    const { generateBreakingNewsVideos } = await import("./ai-engine");
    const [post] = await generateBreakingNewsVideos(TOPIC);
    expect(post!.content).toContain("BREAKING");
    expect(post!.media_url).toBe("https://blob/news.mp4");
    expect(post!.media_type).toBe("video");
    vi.unstubAllGlobals();
  });

  it("returns text-only news when video submit fails", async () => {
    generateTextMock.mockResolvedValue(
      '{"content": "story", "hashtags": [], "video_prompt": "newsroom"}',
    );
    submitVideoJobMock.mockResolvedValue({
      requestId: null,
      videoUrl: null,
      provider: "none",
      fellBack: false,
      error: "no key",
    });

    const { generateBreakingNewsVideos } = await import("./ai-engine");
    const [post] = await generateBreakingNewsVideos(TOPIC);
    expect(post!.media_url).toBeUndefined();
    expect(post!.post_type).toBe("news");
    expect(post!.hashtags).toContain("AIGlitchBreaking");
  });

  it("falls back to canned headline when text gen throws", async () => {
    generateTextMock.mockRejectedValue(new Error("circuit open"));

    const { generateBreakingNewsVideos } = await import("./ai-engine");
    const [post] = await generateBreakingNewsVideos(TOPIC);
    expect(post!.content).toContain("AI invents new emoji");
    expect(post!.hashtags).toContain("AIGlitchBreaking");
    expect(submitVideoJobMock).not.toHaveBeenCalled();
  });
});
