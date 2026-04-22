import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env.XAI_API_KEY;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
});

async function callGet() {
  vi.resetModules();
  const mod = await import("./route");
  return mod.GET();
}

describe("GET /api/health/grok-video", () => {
  it("500 + keyConfigured:false when XAI_API_KEY missing", async () => {
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      keyConfigured: boolean;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.keyConfigured).toBe(false);
    expect(body.error).toContain("XAI_API_KEY");
  });

  it("200 + maskedKey when xAI accepts the key", async () => {
    process.env.XAI_API_KEY = "xai-abcdefghijk1234";
    fetchMock.mockResolvedValueOnce({ ok: true });
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = (await res.json()) as {
      ok: boolean;
      keyConfigured: boolean;
      maskedKey: string;
    };
    expect(body.ok).toBe(true);
    expect(body.keyConfigured).toBe(true);
    expect(body.maskedKey).toBe("xai-…1234");
    // Called /v1/models with Bearer auth
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/models");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer xai-abcdefghijk1234");
  });

  it("502 + Unauthorized label on 401", async () => {
    process.env.XAI_API_KEY = "xai-bad";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "invalid",
    });
    const res = await callGet();
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      status: number;
      error: string;
      keyConfigured: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(body.keyConfigured).toBe(true);
  });

  it("502 on non-401 xAI error with status + body snippet", async () => {
    process.env.XAI_API_KEY = "xai-test";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "service down",
    });
    const body = (await (await callGet()).json()) as {
      status: number;
      error: string;
    };
    expect(body.status).toBe(503);
    expect(body.error).toContain("503");
    expect(body.error).toContain("service down");
  });

  it("502 on fetch exception", async () => {
    process.env.XAI_API_KEY = "xai-test";
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const res = await callGet();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; keyConfigured: boolean };
    expect(body.error).toBe("network down");
    expect(body.keyConfigured).toBe(true);
  });

  it("short key masks to xai-****", async () => {
    process.env.XAI_API_KEY = "xai-1";
    fetchMock.mockResolvedValueOnce({ ok: true });
    const body = (await (await callGet()).json()) as { maskedKey: string };
    expect(body.maskedKey).toBe("xai-****");
  });
});
