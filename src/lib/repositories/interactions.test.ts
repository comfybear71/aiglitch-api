/**
 * Unit tests for triggerAIReply (AI auto-reply after human comment).
 *
 * Isolates the function from the AI SDK and DB by mocking both.
 * Each test controls Math.random() to deterministically exercise
 * the probability gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateReply = vi.fn();

vi.mock("@/lib/ai/generate", () => ({
  generateReplyToHuman: mockGenerateReply,
}));

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift() ?? [];
  return Promise.resolve(next);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

const SQL_OF = (call: SqlCall) => call.strings.join("?");

const POST_ROW = {
  id: "post-1",
  content: "Hot take incoming",
  persona_id: "glitch-001",
  display_name: "Glitch One",
  bio: "A rogue AI",
  persona_type: "comedian",
};

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
  mockGenerateReply.mockReset();
  vi.spyOn(Math, "random").mockReturnValue(0); // always pass probability check
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("triggerAIReply", () => {
  it("skips when parentCommentId is set (only top-level get replies)", async () => {
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({
      postId: "p-1",
      sessionId: "s-1",
      humanComment: "thanks!",
      parentCommentId: "parent-42",
    });
    expect(fake.calls).toHaveLength(0);
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it("skips when probability roll fails (random >= 0.30)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "p-1", sessionId: "s-1", humanComment: "hi" });
    expect(fake.calls).toHaveLength(0);
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it("fires when probability roll passes (random < 0.30)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.10);
    fake.results = [
      [POST_ROW], // SELECT post + persona
      [],         // INSERT reply post
      [],         // UPDATE comment_count
      [],         // INSERT notification
      [],         // awardPersonaCoins INSERT
      [],         // awardPersonaCoins INSERT (coin_transactions)
    ];
    mockGenerateReply.mockResolvedValue("Great point!");
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "post-1", sessionId: "s-1", humanComment: "hi" });
    expect(mockGenerateReply).toHaveBeenCalledTimes(1);
    expect(mockGenerateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: expect.objectContaining({ personaId: "glitch-001", displayName: "Glitch One" }),
        humanMessage: "hi",
        postContext: "Hot take incoming",
      }),
    );
  });

  it("exits early when post is not found", async () => {
    fake.results = [[]]; // SELECT returns no rows
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "ghost", sessionId: "s-1", humanComment: "hi" });
    expect(mockGenerateReply).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(1); // only the SELECT
  });

  it("exits early when generateReplyToHuman returns empty string", async () => {
    fake.results = [[POST_ROW]];
    mockGenerateReply.mockResolvedValue("   ");
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "post-1", sessionId: "s-1", humanComment: "hi" });
    // Only the SELECT ran — no INSERT
    expect(fake.calls).toHaveLength(1);
  });

  it("inserts reply post with is_reply_to and post_type ai_comment", async () => {
    fake.results = [
      [POST_ROW],
      [], [], [], [], [],
    ];
    mockGenerateReply.mockResolvedValue("Sharp observation!");
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "post-1", sessionId: "s-1", humanComment: "test" });
    const insertCall = fake.calls.find((c) => SQL_OF(c).includes("INSERT INTO posts"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.values).toContain("ai_comment");
    expect(insertCall!.values).toContain("post-1"); // is_reply_to
    expect(insertCall!.values).toContain("glitch-001"); // persona_id
    expect(insertCall!.values).toContain("Sharp observation!"); // content
  });

  it("increments comment_count on the original post", async () => {
    fake.results = [
      [POST_ROW],
      [], [], [], [], [],
    ];
    mockGenerateReply.mockResolvedValue("Interesting!");
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "post-1", sessionId: "s-1", humanComment: "test" });
    const updateCall = fake.calls.find(
      (c) => SQL_OF(c).includes("UPDATE posts") && SQL_OF(c).includes("comment_count"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.values).toContain("post-1");
  });

  it("inserts ai_reply notification for the human session", async () => {
    fake.results = [
      [POST_ROW],
      [], [], [], [], [],
    ];
    mockGenerateReply.mockResolvedValue("Reply text");
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "post-1", sessionId: "session-abc", humanComment: "test" });
    const notifCall = fake.calls.find((c) => SQL_OF(c).includes("INSERT INTO notifications"));
    expect(notifCall).toBeDefined();
    expect(notifCall!.values).toContain("session-abc");
    expect(notifCall!.values).toContain("ai_reply");
    expect(notifCall!.values).toContain("glitch-001");
    expect(notifCall!.values).toContain("Glitch One replied to your comment");
  });

  it("swallows all errors (fire-and-forget contract)", async () => {
    fake.results = [[POST_ROW]];
    mockGenerateReply.mockRejectedValue(new Error("AI API down"));
    const { triggerAIReply } = await import("./interactions");
    await expect(
      triggerAIReply({ postId: "post-1", sessionId: "s-1", humanComment: "hi" }),
    ).resolves.toBeUndefined();
  });

  it("passes bio and persona_type as personality to generateReplyToHuman", async () => {
    fake.results = [
      [{ ...POST_ROW, bio: "A wild AI", persona_type: "satirist" }],
      [], [], [], [], [],
    ];
    mockGenerateReply.mockResolvedValue("Witty comeback");
    const { triggerAIReply } = await import("./interactions");
    await triggerAIReply({ postId: "post-1", sessionId: "s-1", humanComment: "test" });
    expect(mockGenerateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: expect.objectContaining({ bio: "A wild AI", personality: "satirist" }),
      }),
    );
  });
});
