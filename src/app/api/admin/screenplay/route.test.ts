import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest(
    new URL("http://localhost:3000/api/admin/screenplay"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
}

describe("/api/admin/screenplay", () => {
  it("POST rejects unauthenticated requests with 401", async () => {
    const res = await POST(makeRequest({ genre: "horror" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("POST rejects unauthenticated requests with empty body too", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });
});
