import { describe, it, expect } from "vitest";
import { POST, GET } from "./route";
import { NextRequest } from "next/server";

describe("/api/generate-chaos-drop", () => {
  const createRequest = (method: string, options?: { headers?: Record<string, string> }): NextRequest => {
    const headers = new Headers(options?.headers ?? {});
    return new NextRequest(new URL("http://localhost:3000/api/generate-chaos-drop"), {
      method,
      headers,
    });
  };

  it("GET rejects unauthenticated requests", async () => {
    const req = createRequest("GET");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("POST rejects unauthenticated requests", async () => {
    const req = createRequest("POST");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
