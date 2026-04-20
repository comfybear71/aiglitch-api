import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDel = vi.fn();
const mockIncr = vi.fn();
const mockExpire = vi.fn();

vi.mock("@upstash/redis", () => ({
  Redis: class {
    get = mockGet;
    set = mockSet;
    del = mockDel;
    incr = mockIncr;
    expire = mockExpire;
  },
}));

const TEST_CONFIG = {
  failureThreshold: 3,
  windowMs: 10_000,
  cooldownMs: 30_000,
};

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  vi.resetModules();
  mockGet.mockReset();
  mockSet.mockReset();
  mockDel.mockReset();
  mockIncr.mockReset();
  mockExpire.mockReset();
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("getCircuitState", () => {
  it("returns closed when no open_until key", async () => {
    mockGet.mockResolvedValue(null);
    const { getCircuitState, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await getCircuitState("xai")).toBe("closed");
  });

  it("returns open when open_until is in the future", async () => {
    mockGet.mockResolvedValue(Date.now() + 60_000);
    const { getCircuitState, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await getCircuitState("xai")).toBe("open");
  });

  it("returns half_open when open_until is in the past", async () => {
    mockGet.mockResolvedValue(Date.now() - 1);
    const { getCircuitState, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await getCircuitState("xai")).toBe("half_open");
  });

  it("returns closed (fail-open) when Redis is unavailable", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { getCircuitState, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await getCircuitState("xai")).toBe("closed");
  });

  it("returns closed (fail-open) on Redis error", async () => {
    mockGet.mockRejectedValue(new Error("Redis connection refused"));
    const { getCircuitState, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await getCircuitState("xai")).toBe("closed");
  });
});

describe("canProceed", () => {
  it("returns true when CLOSED", async () => {
    mockGet.mockResolvedValue(null);
    const { canProceed, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await canProceed("xai")).toBe(true);
  });

  it("returns false when OPEN", async () => {
    mockGet.mockResolvedValue(Date.now() + 60_000);
    const { canProceed, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await canProceed("xai")).toBe(false);
  });

  it("returns true when HALF_OPEN (probe allowed)", async () => {
    mockGet.mockResolvedValue(Date.now() - 1);
    const { canProceed, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    expect(await canProceed("xai")).toBe(true);
  });
});

describe("recordFailure", () => {
  it("trips breaker when failure count reaches threshold", async () => {
    mockIncr.mockResolvedValue(TEST_CONFIG.failureThreshold);
    mockExpire.mockResolvedValue(1);
    mockSet.mockResolvedValue("OK");
    const { recordFailure, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    await recordFailure("xai", TEST_CONFIG);
    expect(mockSet).toHaveBeenCalledWith(
      "cb:xai:open_until",
      expect.any(Number),
      expect.objectContaining({ px: TEST_CONFIG.cooldownMs * 2 }),
    );
  });

  it("does not trip breaker below threshold", async () => {
    mockIncr.mockResolvedValue(TEST_CONFIG.failureThreshold - 1);
    mockExpire.mockResolvedValue(1);
    const { recordFailure, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    await recordFailure("xai", TEST_CONFIG);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("swallows Redis errors (fail-open)", async () => {
    mockIncr.mockRejectedValue(new Error("Redis down"));
    const { recordFailure, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    await expect(recordFailure("xai", TEST_CONFIG)).resolves.toBeUndefined();
  });

  it("does nothing when Redis not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { recordFailure, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    await recordFailure("xai", TEST_CONFIG);
    expect(mockIncr).not.toHaveBeenCalled();
  });
});

describe("recordSuccess", () => {
  it("clears open_until and failures keys", async () => {
    mockDel.mockResolvedValue(1);
    const { recordSuccess, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    await recordSuccess("anthropic");
    expect(mockDel).toHaveBeenCalledWith("cb:anthropic:open_until");
    expect(mockDel).toHaveBeenCalledWith("cb:anthropic:failures");
  });

  it("swallows Redis errors (fail-open)", async () => {
    mockDel.mockRejectedValue(new Error("Redis down"));
    const { recordSuccess, __resetBreakerClient } = await import("./circuit-breaker");
    __resetBreakerClient();
    await expect(recordSuccess("xai")).resolves.toBeUndefined();
  });
});
