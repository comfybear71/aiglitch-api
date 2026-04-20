import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIPersona } from "@/lib/personas";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
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
