/**
 * Integration tests for POST /api/auth/admin.
 *
 * - 401 on all invalid input variants (no body, non-string password,
 *   empty password, wrong password, ADMIN_PASSWORD unset)
 * - 429 on rate limit (5 per IP per 15 minutes) with Retry-After
 * - Successful auth resets the rate limit counter for that IP
 * - Successful auth issues an httpOnly SameSite=Lax cookie with the
 *   HMAC token and a 7-day max-age
 * - Constant-time comparison — all wrong-password attempts return
 *   the same generic "Invalid credentials" error
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function callPost(body: unknown, ip = "9.9.9.1") {
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/auth/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return mod.POST(req);
}

async function resetLimiter() {
  const mod = await import("@/lib/rate-limit");
  mod.adminLoginLimiter.clear();
}

beforeEach(async () => {
  process.env.ADMIN_PASSWORD = "hunter2";
  await resetLimiter();
});

afterEach(async () => {
  delete process.env.ADMIN_PASSWORD;
  await resetLimiter();
});

describe("POST /api/auth/admin", () => {
  it("200 + sets httpOnly cookie on correct password", async () => {
    const res = await callPost({ password: "hunter2" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie!).toContain("aiglitch-admin-token=");
    expect(setCookie!.toLowerCase()).toContain("httponly");
    expect(setCookie!.toLowerCase()).toContain("samesite=lax");
    expect(setCookie!.toLowerCase()).toContain("path=/");
    // 7 days = 604800 seconds
    expect(setCookie!).toContain("Max-Age=604800");
  });

  it("401 on wrong password (generic error)", async () => {
    const res = await callPost({ password: "notthepassword" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid credentials");
  });

  it("401 on empty-string password", async () => {
    const res = await callPost({ password: "" });
    expect(res.status).toBe(401);
  });

  it("401 on non-string password (number)", async () => {
    const res = await callPost({ password: 12345 });
    expect(res.status).toBe(401);
  });

  it("401 on missing password field", async () => {
    const res = await callPost({});
    expect(res.status).toBe(401);
  });

  it("401 on malformed JSON body", async () => {
    const { NextRequest } = await import("next/server");
    const mod = await import("./route");
    const req = new NextRequest("http://localhost/api/auth/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.2" },
      body: "not-json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });

  it("401 when ADMIN_PASSWORD env var not set (config-safe)", async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await callPost({ password: "anything" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid credentials");
  });

  it("429 once the same IP hits 5 failed attempts within the window", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await callPost({ password: "wrong" }, "10.0.0.1");
      expect(res.status).toBe(401);
    }
    const res = await callPost({ password: "wrong" }, "10.0.0.1");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Too many");
  });

  it("rate limit is per-IP — different IPs don't share counters", async () => {
    for (let i = 0; i < 5; i += 1) {
      await callPost({ password: "wrong" }, "10.0.0.2");
    }
    const blocked = await callPost({ password: "wrong" }, "10.0.0.2");
    expect(blocked.status).toBe(429);
    const fresh = await callPost({ password: "wrong" }, "10.0.0.3");
    expect(fresh.status).toBe(401);
  });

  it("successful login resets the rate counter for that IP", async () => {
    for (let i = 0; i < 4; i += 1) {
      const r = await callPost({ password: "wrong" }, "10.0.0.4");
      expect(r.status).toBe(401);
    }
    const success = await callPost({ password: "hunter2" }, "10.0.0.4");
    expect(success.status).toBe(200);
    // Same IP can now do 5 more failed attempts before hitting 429
    for (let i = 0; i < 5; i += 1) {
      const r = await callPost({ password: "wrong" }, "10.0.0.4");
      expect(r.status).toBe(401);
    }
    const blocked = await callPost({ password: "wrong" }, "10.0.0.4");
    expect(blocked.status).toBe(429);
  });

  it("uses first IP from x-forwarded-for (comma-separated list)", async () => {
    const { NextRequest } = await import("next/server");
    const mod = await import("./route");
    // Hit the "real" client IP (7.7.7.7) 5 times
    for (let i = 0; i < 5; i += 1) {
      const req = new NextRequest("http://localhost/api/auth/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": " 7.7.7.7 , 10.0.0.1",
        },
        body: JSON.stringify({ password: "wrong" }),
      });
      await mod.POST(req);
    }
    // Same leading IP in the XFF list → rate-limited
    const req = new NextRequest("http://localhost/api/auth/admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "7.7.7.7, someother",
      },
      body: JSON.stringify({ password: "wrong" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(429);
  });
});
