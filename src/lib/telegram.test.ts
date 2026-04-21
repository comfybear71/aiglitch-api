import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendMessage,
  getAdminChannel,
  sendTelegramPhoto,
  sendTelegramVideo,
} from "./telegram";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHANNEL_ID;
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHANNEL_ID;
});

describe("sendMessage", () => {
  it("calls Telegram API with correct URL and body", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await sendMessage("tok123", "-100999", "hello");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottok123/sendMessage");
    const body = JSON.parse(opts.body as string) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("-100999");
    expect(body.text).toBe("hello");
  });

  it("throws when Telegram returns non-ok status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad Request" });
    await expect(sendMessage("tok", "chat", "hi")).rejects.toThrow("400");
  });
});

describe("getAdminChannel", () => {
  it("returns null when env vars are missing", () => {
    expect(getAdminChannel()).toBeNull();
  });

  it("returns null when only one env var is set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    expect(getAdminChannel()).toBeNull();
  });

  it("returns token and chatId when both env vars are set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok123";
    process.env.TELEGRAM_CHANNEL_ID = "-100abc";
    const ch = getAdminChannel();
    expect(ch).not.toBeNull();
    expect(ch!.token).toBe("tok123");
    expect(ch!.chatId).toBe("-100abc");
  });
});

describe("sendTelegramPhoto", () => {
  it("downloads then uploads as multipart, returns messageId on success", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: new Headers({ "content-type": "image/png" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 42 } }),
      });
    const result = await sendTelegramPhoto(
      "tok",
      "-100abc",
      "https://blob.test/a.png",
      "hello",
    );
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(42);
    const [, uploadOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.telegram.org/bottok/sendPhoto",
    );
    expect(uploadOpts.method).toBe("POST");
    expect(uploadOpts.body).toBeInstanceOf(FormData);
  });

  it("download failure → error result", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await sendTelegramPhoto("tok", "chat", "https://bad.test/x.png");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("download image");
    // No upload call attempted
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Telegram returns ok:false → captures description", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: new Headers({ "content-type": "image/png" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, description: "bot blocked by user" }),
      });
    const result = await sendTelegramPhoto("tok", "chat", "https://blob.test/a.png");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bot blocked by user");
  });

  it("fetch exception during download → download-failed error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const result = await sendTelegramPhoto("tok", "chat", "https://dead.test/x.png");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("download image");
  });

  it("upload exception → error captured at outer layer", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: new Headers({ "content-type": "image/png" }),
      })
      .mockRejectedValueOnce(new Error("telegram 502"));
    const result = await sendTelegramPhoto("tok", "chat", "https://blob.test/a.png");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("telegram 502");
  });
});

describe("sendTelegramVideo", () => {
  it("uploads with supports_streaming + returns messageId on success", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(16),
        headers: new Headers({ "content-type": "video/mp4" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 7 } }),
      });
    const result = await sendTelegramVideo(
      "tok",
      "chat",
      "https://blob.test/v.mp4",
      "caption",
    );
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(7);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.telegram.org/bottok/sendVideo",
    );
  });

  it("download failure → error result", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await sendTelegramVideo("tok", "chat", "https://bad.test/v.mp4");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("download video");
  });
});
