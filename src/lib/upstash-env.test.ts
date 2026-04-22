import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUpstashCredentials } from "./upstash-env";

// Preserve original env so we can fully clean between cases.
const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("getUpstashCredentials", () => {
  it("returns null when neither naming convention is set", () => {
    expect(getUpstashCredentials()).toBeNull();
  });

  it("returns upstash-native values when only UPSTASH_* are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    const creds = getUpstashCredentials();
    expect(creds).toEqual({
      url: "https://upstash.example",
      token: "upstash-token",
      source: "upstash",
    });
  });

  it("returns Vercel KV values when only KV_* are set", () => {
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "kv-token";
    const creds = getUpstashCredentials();
    expect(creds).toEqual({
      url: "https://kv.example",
      token: "kv-token",
      source: "vercel-kv",
    });
  });

  it("prefers UPSTASH_* over KV_* when both are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "kv-token";
    expect(getUpstashCredentials()?.source).toBe("upstash");
  });

  it("returns null when only URL is set without TOKEN (partial config)", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
    expect(getUpstashCredentials()).toBeNull();
  });

  it("returns null when only TOKEN is set without URL (partial config)", () => {
    process.env.KV_REST_API_TOKEN = "kv-token";
    expect(getUpstashCredentials()).toBeNull();
  });
});
