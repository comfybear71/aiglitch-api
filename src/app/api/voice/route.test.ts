import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSettingMock = vi.fn();
vi.mock("@/lib/repositories/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

function mockFetch(responses: {
  ok: boolean;
  status?: number;
  body?: unknown;
  audio?: Buffer | Uint8Array;
}[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) return Promise.reject(new Error("Unexpected extra fetch"));
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: () => Promise.resolve(next.body ?? {}),
      text: () => Promise.resolve(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? "")),
      arrayBuffer: () => {
        const audio = next.audio ?? Buffer.alloc(0);
        const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
        return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      },
    });
  });
}

beforeEach(() => {
  getSettingMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/voice${query}`));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/voice", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("GET /api/voice", () => {
  it("returns enabled:true when voice_disabled is not set", async () => {
    getSettingMock.mockResolvedValue(null);
    const res = await callGET();
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(true);
  });

  it("returns enabled:false when voice_disabled is 'true'", async () => {
    getSettingMock.mockResolvedValue("true");
    const res = await callGET();
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("debug=1 reports no_key when XAI_API_KEY is unset", async () => {
    getSettingMock.mockResolvedValue(null);
    const res = await callGET("?debug=1");
    const body = (await res.json()) as {
      enabled: boolean;
      has_xai_key: boolean;
      xai_tts_status: string;
    };
    expect(body.has_xai_key).toBe(false);
    expect(body.xai_tts_status).toBe("no_key");
  });

  it("debug=1 reports 'working' when xAI TTS probe succeeds", async () => {
    process.env.XAI_API_KEY = "sk-test";
    getSettingMock.mockResolvedValue(null);
    vi.stubGlobal("fetch", mockFetch([{ ok: true, audio: Buffer.from([0x00, 0x01]) }]));

    const res = await callGET("?debug=1");
    const body = (await res.json()) as { xai_tts_status: string; key_prefix: string };
    expect(body.xai_tts_status).toBe("working");
    expect(body.key_prefix).toBe("sk-test...");
  });

  it("debug=1 reports error_XXX when xAI returns non-200", async () => {
    process.env.XAI_API_KEY = "sk-test";
    getSettingMock.mockResolvedValue(null);
    vi.stubGlobal("fetch", mockFetch([{ ok: false, status: 401, body: "nope" }]));

    const res = await callGET("?debug=1");
    const body = (await res.json()) as { xai_tts_status: string };
    expect(body.xai_tts_status).toBe("error_401");
  });
});

describe("POST /api/voice", () => {
  it("403 when admin has disabled voice", async () => {
    getSettingMock.mockResolvedValue("true");
    const res = await callPOST({ text: "hi" });
    expect(res.status).toBe(403);
  });

  it("400 when text is missing or empty", async () => {
    getSettingMock.mockResolvedValue(null);
    expect((await callPOST({})).status).toBe(400);
    expect((await callPOST({ text: "   " })).status).toBe(400);
  });

  it("generates xAI audio and returns it with xai-tts source header", async () => {
    process.env.XAI_API_KEY = "sk-test";
    getSettingMock.mockResolvedValue(null);
    const audio = Buffer.from([0x49, 0x44, 0x33, 0x04]); // fake MP3 header
    vi.stubGlobal("fetch", mockFetch([{ ok: true, audio }]));

    const res = await callPOST({ text: "hello world", persona_id: "glitch-001" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Voice-Source")).toBe("xai-tts");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("serves from cache on a second identical request (single xAI fetch)", async () => {
    process.env.XAI_API_KEY = "sk-test";
    getSettingMock.mockResolvedValue(null);
    const audio = Buffer.from([0x01, 0x02, 0x03]);
    const fetchMock = mockFetch([{ ok: true, audio }]);
    vi.stubGlobal("fetch", fetchMock);

    // Import once so the module-level cache is shared across calls
    const { POST } = await import("./route");
    const { NextRequest } = await import("next/server");
    const build = () =>
      new NextRequest("http://localhost/api/voice", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ text: "cached me", persona_id: "glitch-001" }),
      });

    const first = await POST(build());
    const second = await POST(build());

    expect(first.headers.get("X-Voice-Source")).toBe("xai-tts");
    expect(second.headers.get("X-Voice-Source")).toBe("cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Google TTS when xAI returns non-200 and tags the reason", async () => {
    process.env.XAI_API_KEY = "sk-test";
    getSettingMock.mockResolvedValue(null);
    const googleAudio = Buffer.from([0xff, 0xfb]);
    vi.stubGlobal("fetch", mockFetch([
      { ok: false, status: 500, body: "xai down" },
      { ok: true, audio: googleAudio },
    ]));

    const res = await callPOST({ text: "hi", persona_id: "glitch-001" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Voice-Source")).toBe("google-translate");
    expect(res.headers.get("X-Voice-Fallback-Reason")).toBe("xai-500");
  });

  it("uses Google TTS directly when XAI_API_KEY is unset", async () => {
    getSettingMock.mockResolvedValue(null);
    const googleAudio = Buffer.from([0xff, 0xfb, 0x00]);
    vi.stubGlobal("fetch", mockFetch([{ ok: true, audio: googleAudio }]));

    const res = await callPOST({ text: "no key path" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Voice-Source")).toBe("google-translate");
  });

  it("returns 503 when both xAI and Google TTS fail", async () => {
    process.env.XAI_API_KEY = "sk-test";
    getSettingMock.mockResolvedValue(null);
    vi.stubGlobal("fetch", mockFetch([
      { ok: false, status: 502, body: "bad gateway" },
      { ok: false, status: 429, body: "throttled" },
    ]));

    const res = await callPOST({ text: "boom" });
    expect(res.status).toBe(503);
  });
});
