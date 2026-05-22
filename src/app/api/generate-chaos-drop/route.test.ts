import { describe, it, expect } from "vitest";
import { POST, GET } from "./route";
import { NextRequest } from "next/server";

describe("/api/generate-chaos-drop", () => {
  const createRequest = (
    method: string,
    options?: { url?: string; headers?: Record<string, string> },
  ): NextRequest => {
    const headers = new Headers(options?.headers ?? {});
    return new NextRequest(
      new URL(options?.url ?? "http://localhost:3000/api/generate-chaos-drop"),
      { method, headers },
    );
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

  it("GET ?action=preview is public and returns a scenario", async () => {
    const req = createRequest("GET", {
      url: "http://localhost:3000/api/generate-chaos-drop?action=preview",
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      scenario: { id: string; category: string; title: string };
      renderedPrompt: string;
      renderedCaption: string;
      totalScenarios: number;
    };
    expect(body.success).toBe(true);
    expect(body.scenario.id).toBeTruthy();
    expect(body.totalScenarios).toBeGreaterThan(0);
    // Preview substitutes sample tokens — neither should still contain the placeholder.
    expect(body.renderedPrompt).not.toContain("{persona}");
    expect(body.renderedCaption).not.toContain("{product}");
  });

  it("GET ?action=preview&scenario=<id> honours the override", async () => {
    const req = createRequest("GET", {
      url: "http://localhost:3000/api/generate-chaos-drop?action=preview&scenario=anxiety-blanket",
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: { id: string } };
    expect(body.scenario.id).toBe("anxiety-blanket");
  });
});

