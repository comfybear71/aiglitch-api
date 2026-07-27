import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendTelegramMessage = vi.fn();
const sendTelegramPhoto = vi.fn();
const sendTelegramVideo = vi.fn();

vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramVideo,
}));

describe("notifyMeatLabPendingSubmission", () => {
  beforeEach(() => {
    vi.resetModules();
    sendTelegramMessage.mockReset().mockResolvedValue({ ok: true });
    sendTelegramPhoto.mockReset().mockResolvedValue({ ok: true });
    sendTelegramVideo.mockReset().mockResolvedValue({ ok: true });
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHANNEL_ID = "-100123";
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHANNEL_ID;
    delete process.env.TELEGRAM_GROUP_ID;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.ADMIN_APP_URL;
  });

  it("skips when Telegram is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { notifyMeatLabPendingSubmission } = await import("./meatlab-notify");
    const result = await notifyMeatLabPendingSubmission({
      submissionId: "sub-1",
      title: "Test",
      description: "",
      mediaUrl: "https://blob/x.mp4",
      mediaType: "video",
      creatorName: "Stu",
    });
    expect(result.ok).toBe(false);
    expect(sendTelegramVideo).not.toHaveBeenCalled();
  });

  it("sends video preview for pending video submissions", async () => {
    const { notifyMeatLabPendingSubmission } = await import("./meatlab-notify");
    const result = await notifyMeatLabPendingSubmission({
      submissionId: "sub-2",
      title: "Glitch Vid",
      description: "Cool",
      mediaUrl: "https://blob/x.mp4",
      mediaType: "video",
      creatorName: "Meat Bag",
      creatorUsername: "stu",
      pendingCount: 3,
    });
    expect(result.ok).toBe(true);
    expect(sendTelegramVideo).toHaveBeenCalledWith(
      "test-token",
      "-100123",
      "https://blob/x.mp4",
      expect.stringContaining("MEATLAB — REVIEW NEEDED"),
    );
    expect(sendTelegramVideo.mock.calls[0][3]).toContain("admin.aiglitch.app/meatlab");
    expect(sendTelegramVideo.mock.calls[0][3]).toContain("3");
  });

  it("sends photo preview for image submissions", async () => {
    const { notifyMeatLabPendingSubmission } = await import("./meatlab-notify");
    await notifyMeatLabPendingSubmission({
      submissionId: "sub-3",
      title: "Art",
      description: "",
      mediaUrl: "https://blob/x.png",
      mediaType: "image",
      creatorName: "Creator",
    });
    expect(sendTelegramPhoto).toHaveBeenCalled();
    expect(sendTelegramVideo).not.toHaveBeenCalled();
  });
});
