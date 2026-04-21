import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

function mockFetch(responses: { ok: boolean; status?: number; body?: unknown }[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift();
    if (!next) return Promise.reject(new Error("Unexpected extra fetch"));
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      json: () => Promise.resolve(next.body ?? {}),
      text: () => Promise.resolve(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? "")),
    });
  });
}

beforeEach(() => {
  mockIsAdmin = false;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/sponsor-clip", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("POST /api/admin/sponsor-clip — auth + validation", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ sponsorNames: ["Acme"] })).status).toBe(401);
  });

  it("400 on invalid JSON", async () => {
    mockIsAdmin = true;
    const res = await callPOST("not json{");
    expect(res.status).toBe(400);
  });

  it("400 when sponsorNames missing or empty", async () => {
    mockIsAdmin = true;
    expect((await callPOST({})).status).toBe(400);
    expect((await callPOST({ sponsorNames: [] })).status).toBe(400);
  });

  it("500 when XAI_API_KEY is not configured", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ sponsorNames: ["Acme"] });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/admin/sponsor-clip — submission flow", () => {
  beforeEach(() => {
    mockIsAdmin = true;
    process.env.XAI_API_KEY = "sk-test";
  });

  it("text-to-video when no sponsor images supplied", async () => {
    const fetchMock = mockFetch([{ ok: true, body: { request_id: "req-123" } }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({ sponsorNames: ["Acme"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestId: string; mode: string };
    expect(body).toEqual({ requestId: "req-123", mode: "text-to-video" });

    const grokCall = fetchMock.mock.calls[0];
    const payload = JSON.parse((grokCall[1] as { body: string }).body);
    expect(payload.prompt).toContain("sponsor acknowledgment");
    expect(payload.image_url).toBeUndefined();
    expect(payload.duration).toBe(5);
    expect(payload.aspect_ratio).toBe("16:9");
  });

  it("image-to-video when product image supplied — uses first image as seed", async () => {
    const fetchMock = mockFetch([{ ok: true, body: { request_id: "req-xyz" } }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({
      sponsorNames: ["Acme", "Beta"],
      sponsorImages: ["https://cdn.example.com/logo.png", "https://cdn.example.com/product.png"],
    });
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("image-to-video");

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.image_url).toBe("https://cdn.example.com/logo.png");
    expect(payload.prompt).toContain("Acme, Beta");
  });

  it("accepts `id` field as requestId (Grok fallback response shape)", async () => {
    vi.stubGlobal("fetch", mockFetch([{ ok: true, body: { id: "fallback-id" } }]));

    const res = await callPOST({ sponsorNames: ["Acme"] });
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe("fallback-id");
  });

  it("502 when Grok returns non-2xx", async () => {
    vi.stubGlobal("fetch", mockFetch([{ ok: false, status: 400, body: { error: "Invalid model" } }]));
    const res = await callPOST({ sponsorNames: ["Acme"] });
    expect(res.status).toBe(502);
  });

  it("502 when Grok returns 2xx but no request id", async () => {
    vi.stubGlobal("fetch", mockFetch([{ ok: true, body: {} }]));
    const res = await callPOST({ sponsorNames: ["Acme"] });
    expect(res.status).toBe(502);
  });

  it("500 when Grok fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await callPOST({ sponsorNames: ["Acme"] });
    expect(res.status).toBe(500);
  });
});
