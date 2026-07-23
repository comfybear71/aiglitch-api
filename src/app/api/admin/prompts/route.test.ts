import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const buildCatalogMock = vi.fn();
const saveMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/lib/prompt-catalog", () => ({
  buildPromptCatalog: () => buildCatalogMock(),
}));

vi.mock("@/lib/prompt-overrides", () => ({
  savePromptOverride: (...args: unknown[]) => saveMock(...args),
  deletePromptOverride: (...args: unknown[]) => deleteMock(...args),
}));

beforeEach(() => {
  mockIsAdmin = false;
  buildCatalogMock.mockReset();
  saveMock.mockReset();
  deleteMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/prompts"));
}

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/prompts", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("GET /api/admin/prompts", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns populated catalog", async () => {
    mockIsAdmin = true;
    buildCatalogMock.mockResolvedValue({
      channels: [{ channelId: "ch-gnn", channelName: "GNN", prompts: [] }],
      directors: [{ directorUsername: "steven_spielbot", prompts: [] }],
      genres: [{ genreKey: "action", prompts: [] }],
      platform: [{ prompts: [] }],
      overrideCount: 2,
    });
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: unknown[];
      directors: unknown[];
      genres: unknown[];
      platform: unknown[];
      overrideCount: number;
    };
    expect(body.channels).toHaveLength(1);
    expect(body.directors).toHaveLength(1);
    expect(body.genres).toHaveLength(1);
    expect(body.platform).toHaveLength(1);
    expect(body.overrideCount).toBe(2);
  });

  it("500 when buildPromptCatalog throws", async () => {
    mockIsAdmin = true;
    buildCatalogMock.mockRejectedValue(new Error("db down"));
    const res = await callGET();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/admin/prompts — save", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ action: "save", category: "c", key: "k", value: "v" })).status).toBe(401);
  });

  it("400 when any of category/key/value missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({ action: "save", category: "c", key: "k" })).status).toBe(400);
    expect((await callPOST({ action: "save", category: "c", value: "v" })).status).toBe(400);
    expect((await callPOST({ action: "save", key: "k", value: "v" })).status).toBe(400);
  });

  it("upserts the override (defaults label to key when not supplied)", async () => {
    mockIsAdmin = true;
    saveMock.mockResolvedValue(undefined);
    const res = await callPOST({ action: "save", category: "channel", key: "gnn.promptHint", value: "edgy" });
    expect(res.status).toBe(200);
    expect(saveMock).toHaveBeenCalledWith("channel", "gnn.promptHint", "gnn.promptHint", "edgy");
  });

  it("uses provided label when given", async () => {
    mockIsAdmin = true;
    saveMock.mockResolvedValue(undefined);
    await callPOST({
      action: "save",
      category: "channel",
      key: "gnn.promptHint",
      label: "GNN Hint",
      value: "edgy",
    });
    expect(saveMock).toHaveBeenCalledWith("channel", "gnn.promptHint", "GNN Hint", "edgy");
  });

  it("500 when save throws", async () => {
    mockIsAdmin = true;
    saveMock.mockRejectedValue(new Error("db fail"));
    const res = await callPOST({ action: "save", category: "c", key: "k", value: "v" });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/admin/prompts — reset", () => {
  it("400 when category or key missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({ action: "reset", category: "c" })).status).toBe(400);
    expect((await callPOST({ action: "reset", key: "k" })).status).toBe(400);
  });

  it("deletes the override on reset", async () => {
    mockIsAdmin = true;
    deleteMock.mockResolvedValue(undefined);
    const res = await callPOST({ action: "reset", category: "channel", key: "gnn.promptHint" });
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith("channel", "gnn.promptHint");
  });
});

describe("POST /api/admin/prompts — unknown action", () => {
  it("400 on unknown action", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ action: "mystery" });
    expect(res.status).toBe(400);
  });
});
