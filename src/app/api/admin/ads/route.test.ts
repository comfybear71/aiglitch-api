/**
 * Tests for /api/admin/ads — list + create briefs.
 *
 * The route delegates DB work to `lib/content/ad-briefs`; we mock that
 * module so these specs cover only the route's auth + validation +
 * response shaping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const listBriefsMock = vi.fn();
const createBriefMock = vi.fn();
vi.mock("@/lib/content/ad-briefs", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/content/ad-briefs")>(
      "@/lib/content/ad-briefs",
    );
  return {
    ...actual,
    listBriefs: (...args: unknown[]) => listBriefsMock(...args),
    createBrief: (...args: unknown[]) => createBriefMock(...args),
  };
});

beforeEach(() => {
  mockIsAdmin = false;
  listBriefsMock.mockReset();
  createBriefMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(method: "GET" | "POST", opts: { query?: string; body?: unknown } = {}) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (opts.body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(opts.body);
  }
  const url = `http://localhost/api/admin/ads${opts.query ?? ""}`;
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/ads", () => {
  it("401 when not admin", async () => {
    const res = await call("GET");
    expect(res.status).toBe(401);
  });

  it("returns the listBriefs payload + total", async () => {
    mockIsAdmin = true;
    listBriefsMock.mockResolvedValue([
      { id: "a", title: "A", project_name: "P" },
      { id: "b", title: "B", project_name: "P" },
    ]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      briefs: Array<{ id: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.briefs[0]!.id).toBe("a");
  });

  it("400 on invalid status query", async () => {
    mockIsAdmin = true;
    const res = await call("GET", { query: "?status=banana" });
    expect(res.status).toBe(400);
    expect(listBriefsMock).not.toHaveBeenCalled();
  });

  it("passes status + project_name + includeArchived + limit through", async () => {
    mockIsAdmin = true;
    listBriefsMock.mockResolvedValue([]);
    await call("GET", {
      query: "?status=draft&project_name=BUDJU&includeArchived=1&limit=42",
    });
    const arg = listBriefsMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.status).toBe("draft");
    expect(arg.project_name).toBe("BUDJU");
    expect(arg.includeArchived).toBe(true);
    expect(arg.limit).toBe(42);
  });
});

describe("POST /api/admin/ads", () => {
  it("401 when not admin", async () => {
    const res = await call("POST", { body: { title: "x", project_name: "y" } });
    expect(res.status).toBe(401);
  });

  it("400 on invalid JSON body", async () => {
    mockIsAdmin = true;
    vi.resetModules();
    const mod = await import("./route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/ads", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{not-json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("400 when title missing", async () => {
    mockIsAdmin = true;
    const res = await call("POST", { body: { project_name: "BUDJU" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("title");
  });

  it("400 when project_name missing", async () => {
    mockIsAdmin = true;
    const res = await call("POST", { body: { title: "x" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("project_name");
  });

  it("201 with the created brief on happy path", async () => {
    mockIsAdmin = true;
    createBriefMock.mockResolvedValue({
      id: "uuid-1",
      title: "x",
      project_name: "P",
      concept: "",
      status: "draft",
      target_socials: null,
      created_at: "now",
      updated_at: "now",
    });
    const res = await call("POST", {
      body: { title: "x", project_name: "P", concept: "" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { brief: { id: string } };
    expect(body.brief.id).toBe("uuid-1");
    expect(createBriefMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "x", project_name: "P" }),
    );
  });

  it("400 when starting status is invalid", async () => {
    mockIsAdmin = true;
    const res = await call("POST", {
      body: { title: "x", project_name: "P", status: "banana" },
    });
    expect(res.status).toBe(400);
  });
});
