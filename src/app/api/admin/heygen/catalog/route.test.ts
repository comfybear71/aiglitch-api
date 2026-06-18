import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const listAvatarsMock = vi.fn();
const listVoicesMock = vi.fn();
const isHeyGenConfiguredMock = vi.fn();
vi.mock("@/lib/ai/heygen", () => ({
  listAvatars: () => listAvatarsMock(),
  listVoices: () => listVoicesMock(),
  isHeyGenConfigured: () => isHeyGenConfiguredMock(),
}));

beforeEach(() => {
  mockIsAdmin = false;
  listAvatarsMock.mockReset();
  listVoicesMock.mockReset();
  isHeyGenConfiguredMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet() {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/admin/heygen/catalog");
  return mod.GET(req);
}

describe("GET /api/admin/heygen/catalog", () => {
  it("401 when not admin", async () => {
    const res = await callGet();
    expect(res.status).toBe(401);
  });

  it("503 with hint when HEYGEN_API_KEY not configured", async () => {
    mockIsAdmin = true;
    isHeyGenConfiguredMock.mockReturnValue(false);
    const res = await callGet();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toContain("HEYGEN_API_KEY");
    expect(body.hint).toContain("Vercel");
  });

  it("returns avatars + voices + filtered suggestions on happy path", async () => {
    mockIsAdmin = true;
    isHeyGenConfiguredMock.mockReturnValue(true);
    listAvatarsMock.mockResolvedValue([
      { avatar_id: "a1", avatar_name: "Anna Professional Suit", gender: "female" },
      { avatar_id: "a2", avatar_name: "Cartoon Pirate Captain", gender: "male" },
      { avatar_id: "a3", avatar_name: "Newsroom Anchor Mark", gender: "male" },
    ]);
    listVoicesMock.mockResolvedValue([
      { voice_id: "v1", name: "Announcer English Male", language: "English" },
      { voice_id: "v2", name: "Casual Spanish Female", language: "Spanish" },
      { voice_id: "v3", name: "News Broadcaster English", language: "English" },
    ]);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: {
        avatars: number;
        voices: number;
        news_anchor_avatars: number;
        news_anchor_voices: number;
      };
      suggestions: {
        news_anchor_avatars: Array<{ avatar_id: string }>;
        news_anchor_voices: Array<{ voice_id: string }>;
      };
      avatars: Array<{ avatar_id: string }>;
      voices: Array<{ voice_id: string }>;
    };

    expect(body.counts.avatars).toBe(3);
    expect(body.counts.voices).toBe(3);
    // Suggestions filter:
    //   avatars — keeps "Anna Professional Suit" + "Newsroom Anchor Mark",
    //   drops "Cartoon Pirate Captain"
    expect(body.counts.news_anchor_avatars).toBe(2);
    expect(body.suggestions.news_anchor_avatars.map((a) => a.avatar_id).sort()).toEqual([
      "a1",
      "a3",
    ]);
    // voices — keeps Announcer English + News Broadcaster English,
    // drops the Spanish one
    expect(body.counts.news_anchor_voices).toBe(2);
    expect(body.suggestions.news_anchor_voices.map((v) => v.voice_id).sort()).toEqual([
      "v1",
      "v3",
    ]);
  });

  it("500 when HeyGen list-avatars throws", async () => {
    mockIsAdmin = true;
    isHeyGenConfiguredMock.mockReturnValue(true);
    listAvatarsMock.mockRejectedValue(new Error("HTTP 401: Bad key"));
    listVoicesMock.mockResolvedValue([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("HeyGen catalog fetch failed");
    expect(body.error).toContain("HTTP 401: Bad key");
    errSpy.mockRestore();
  });
});
