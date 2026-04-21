import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
vi.mock("@/lib/repositories/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
  setSetting: (...args: unknown[]) => setSettingMock(...args),
}));

beforeEach(() => {
  mockIsAdmin = false;
  getSettingMock.mockReset();
  setSettingMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGET(query = "") {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/admin/settings${query}`));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/settings", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("GET /api/admin/settings", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns voice_disabled:false by default", async () => {
    mockIsAdmin = true;
    getSettingMock.mockResolvedValue(null);
    const res = await callGET();
    const body = (await res.json()) as { voice_disabled: boolean };
    expect(body.voice_disabled).toBe(false);
  });

  it("returns voice_disabled:true when setting is 'true'", async () => {
    mockIsAdmin = true;
    getSettingMock.mockResolvedValue("true");
    const res = await callGET();
    const body = (await res.json()) as { voice_disabled: boolean };
    expect(body.voice_disabled).toBe(true);
  });

  it("returns specific key lookup when ?key= is provided", async () => {
    mockIsAdmin = true;
    getSettingMock.mockResolvedValue("42");
    const res = await callGET("?key=throttle");
    const body = (await res.json()) as { key: string; value: string | null };
    expect(body).toEqual({ key: "throttle", value: "42" });
  });
});

describe("POST /api/admin/settings", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ key: "voice_disabled", value: "true" })).status).toBe(401);
  });

  it("400 when key missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({ value: "x" })).status).toBe(400);
  });

  it("400 when value missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({ key: "voice_disabled" })).status).toBe(400);
  });

  it("400 when key is not in the whitelist", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ key: "arbitrary_key", value: "42" });
    expect(res.status).toBe(400);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("writes a whitelisted key and stringifies the value", async () => {
    mockIsAdmin = true;
    setSettingMock.mockResolvedValue(undefined);
    const res = await callPOST({ key: "voice_disabled", value: true });
    expect(res.status).toBe(200);
    expect(setSettingMock).toHaveBeenCalledWith("voice_disabled", "true");
    const body = (await res.json()) as { success: boolean; value: string };
    expect(body.success).toBe(true);
    expect(body.value).toBe("true");
  });
});
