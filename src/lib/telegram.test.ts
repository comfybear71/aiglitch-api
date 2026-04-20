import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage, getAdminChannel } from "./telegram";

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
