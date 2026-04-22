import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-auth", () => ({ isAdminAuthenticated: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { GET } from "./route";

function makeReq(path: string | null): NextRequest {
  const url = path
    ? `http://localhost/api/admin/migration/route-hint?path=${encodeURIComponent(path)}`
    : "http://localhost/api/admin/migration/route-hint";
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAdminAuthenticated).mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/migration/route-hint", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(isAdminAuthenticated).mockResolvedValue(false);
    const res = await GET(makeReq("/api/health"));
    expect(res.status).toBe(401);
  });

  it("400 when ?path is missing", async () => {
    const res = await GET(makeReq(null));
    expect(res.status).toBe(400);
  });

  it("400 when ?path doesn't start with /api/", async () => {
    const res = await GET(makeReq("/status"));
    expect(res.status).toBe(400);
  });

  it("returns curated hint for a path in ROUTE_HINTS", async () => {
    const res = await GET(makeReq("/api/health"));
    const body = (await res.json()) as {
      path: string;
      source: string;
      methods: Record<string, { description: string }>;
    };
    expect(body.source).toBe("curated");
    expect(body.path).toBe("/api/health");
    expect(body.methods.GET?.description).toContain("Liveness");
  });

  it("falls back to jsdoc when path is not in the catalogue but file exists", async () => {
    vi.mocked(readFile).mockResolvedValue(`/**
 * GET /api/uncurated/example
 *
 * Example doc comment used as fallback.
 */
export function GET() {}
` as never);
    const res = await GET(makeReq("/api/uncurated/example"));
    const body = (await res.json()) as { source: string; jsdoc?: string };
    expect(body.source).toBe("jsdoc");
    expect(body.jsdoc).toContain("Example doc comment");
  });

  it("returns source=none when neither curated nor jsdoc is available", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const res = await GET(makeReq("/api/does-not-exist-xyz"));
    const body = (await res.json()) as { source: string; message?: string };
    expect(body.source).toBe("none");
    expect(body.message).toContain("No curated hint");
  });

  it("returns source=none when file exists but has no /** comment", async () => {
    vi.mocked(readFile).mockResolvedValue(
      "export function GET() { return Response.json({}); }" as never,
    );
    const res = await GET(makeReq("/api/no-doc-comment"));
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("none");
  });
});
