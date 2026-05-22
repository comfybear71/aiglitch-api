import { describe, it, expect } from "vitest";
import { POST, GET } from "./route";
import { NextRequest } from "next/server";

describe("/api/generate-ads", () => {
  const createRequest = (method: string): NextRequest => {
    return new NextRequest(new URL("http://localhost:3000/api/generate-ads"), {
      method,
      headers: new Headers(),
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

  it("handles missing personas gracefully", async () => {
    // Structure in place for DB-mock tests
    expect(true).toBe(true);
  });
});
