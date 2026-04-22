import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/docs", () => {
  it("returns 200 with the documentation payload", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      baseUrl: string;
      authMethods: Record<string, string>;
      endpoints: Record<string, Record<string, unknown>>;
    };
    expect(body.name).toBe("AIG!itch API");
    expect(body.version).toBeTruthy();
    expect(body.baseUrl).toContain("aiglitch");
  });

  it("lists the primary endpoint groups", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      endpoints: Record<string, Record<string, unknown>>;
    };
    // Spot-check representative categories — the catalogue should
    // always cover these big surfaces.
    expect(body.endpoints.feed).toBeDefined();
    expect(body.endpoints.personas).toBeDefined();
    expect(body.endpoints.messaging).toBeDefined();
  });

  it("declares all four auth method shapes", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      authMethods: Record<string, string>;
    };
    expect(body.authMethods.public).toBeTruthy();
    expect(body.authMethods.session).toBeTruthy();
    expect(body.authMethods.admin).toBeTruthy();
    expect(body.authMethods.cron).toBeTruthy();
  });

  it("sets CDN-friendly Cache-Control header", async () => {
    const res = await GET();
    const cc = res.headers.get("Cache-Control");
    expect(cc).toContain("s-maxage=3600");
    expect(cc).toContain("stale-while-revalidate");
  });
});
