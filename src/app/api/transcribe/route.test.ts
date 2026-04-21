import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function mockFetch(responses: {
  ok: boolean;
  status?: number;
  body?: unknown;
  bodyText?: string;
}[]) {
  const queue = [...responses];
  const fn = vi.fn().mockImplementation((url: string) => {
    const next = queue.shift();
    if (!next) return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: () => Promise.resolve(next.body ?? {}),
      text: () =>
        Promise.resolve(
          next.bodyText ?? (typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? "")),
        ),
    });
  });
  return fn;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/transcribe", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("POST /api/transcribe — validation", () => {
  it("400 on invalid JSON body", async () => {
    const res = await callPOST("not-json{");
    expect(res.status).toBe(400);
  });

  it("400 when audio_base64 is missing", async () => {
    const res = await callPOST({ mime_type: "audio/m4a" });
    expect(res.status).toBe(400);
  });

  it("503 when neither GROQ_API_KEY nor XAI_API_KEY is set", async () => {
    const res = await callPOST({ audio_base64: "AAAA" });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/transcribe — provider dispatch", () => {
  it("returns Groq transcript on first-provider success", async () => {
    process.env.GROQ_API_KEY = "gk-test";
    const fetchMock = mockFetch([{ ok: true, body: { text: "hello world" } }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({ audio_base64: "AAAA", mime_type: "audio/m4a" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; source: string };
    expect(body).toEqual({ text: "hello world", source: "groq" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("groq.com");
  });

  it("falls back to xAI when Groq returns non-200", async () => {
    process.env.GROQ_API_KEY = "gk-test";
    process.env.XAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", mockFetch([
      { ok: false, status: 500, bodyText: "groq down" },
      { ok: true, body: { text: "from xai" } },
    ]));

    const res = await callPOST({ audio_base64: "AAAA" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; source: string };
    expect(body).toEqual({ text: "from xai", source: "xai" });
  });

  it("skips Groq entirely when key is unset and uses xAI directly", async () => {
    process.env.XAI_API_KEY = "sk-test";
    const fetchMock = mockFetch([{ ok: true, body: { text: "xai only" } }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({ audio_base64: "AAAA" });
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("xai");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("x.ai");
  });

  it("503 when both providers fail", async () => {
    process.env.GROQ_API_KEY = "gk-test";
    process.env.XAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", mockFetch([
      { ok: false, status: 500, bodyText: "groq down" },
      { ok: false, status: 502, bodyText: "xai down" },
    ]));

    const res = await callPOST({ audio_base64: "AAAA" });
    expect(res.status).toBe(503);
  });

  it("503 when provider returns empty text", async () => {
    process.env.GROQ_API_KEY = "gk-test";
    vi.stubGlobal("fetch", mockFetch([{ ok: true, body: { text: "   " } }]));

    const res = await callPOST({ audio_base64: "AAAA" });
    expect(res.status).toBe(503);
  });

  it("sends model=whisper-large-v3-turbo to Groq", async () => {
    process.env.GROQ_API_KEY = "gk-test";
    const fetchMock = mockFetch([{ ok: true, body: { text: "ok" } }]);
    vi.stubGlobal("fetch", fetchMock);

    await callPOST({ audio_base64: "AAAA", mime_type: "audio/wav" });
    const call = fetchMock.mock.calls[0];
    const body = (call[1] as { body: ArrayBuffer }).body;
    const payload = Buffer.from(body).toString("utf-8");
    expect(payload).toContain("whisper-large-v3-turbo");
    expect(payload).toContain('filename="audio.wav"');
  });
});
