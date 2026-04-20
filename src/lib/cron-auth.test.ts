import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { requireCronAuth } from "./cron-auth";

function makeRequest(authHeader?: string): NextRequest {
  const req = new NextRequest("http://localhost/api/some-cron", {
    method: "POST",
  });
  if (authHeader !== undefined) {
    Object.defineProperty(req, "headers", {
      value: new Headers({ authorization: authHeader }),
    });
  }
  return req;
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret-123";
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("requireCronAuth", () => {
  it("returns null when token matches secret", async () => {
    const req = new NextRequest("http://localhost/api/cron", { method: "POST" });
    const headers = new Headers({ authorization: "Bearer test-secret-123" });
    const reqWithAuth = new NextRequest("http://localhost/api/cron", {
      method: "POST",
      headers,
    });
    const result = requireCronAuth(reqWithAuth);
    expect(result).toBeNull();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = new NextRequest("http://localhost/api/cron", { method: "POST" });
    const result = requireCronAuth(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 when token is wrong", async () => {
    const req = new NextRequest("http://localhost/api/cron", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer wrong-secret" }),
    });
    const result = requireCronAuth(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 when Authorization is not Bearer scheme", async () => {
    const req = new NextRequest("http://localhost/api/cron", {
      method: "POST",
      headers: new Headers({ authorization: "Basic test-secret-123" }),
    });
    const result = requireCronAuth(req);
    expect(result!.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const req = new NextRequest("http://localhost/api/cron", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer test-secret-123" }),
    });
    const result = requireCronAuth(req);
    expect(result!.status).toBe(500);
  });
});
