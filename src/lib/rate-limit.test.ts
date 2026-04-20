import { beforeEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  describe("sliding window (3 per 1000ms)", () => {
    const config = { maxAttempts: 3, windowMs: 1000 };
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter(config);
    });

    it("allows up to maxAttempts, then blocks", () => {
      expect(limiter.check("ip-1").allowed).toBe(true);
      expect(limiter.check("ip-1").allowed).toBe(true);
      expect(limiter.check("ip-1").allowed).toBe(true);
      expect(limiter.check("ip-1").allowed).toBe(false);
    });

    it("decrements `remaining` after each allowed check", () => {
      expect(limiter.check("ip-1").remaining).toBe(2);
      expect(limiter.check("ip-1").remaining).toBe(1);
      expect(limiter.check("ip-1").remaining).toBe(0);
    });

    it("blocked result carries resetMs > 0", () => {
      for (let i = 0; i < 3; i += 1) limiter.check("ip-1");
      const blocked = limiter.check("ip-1");
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetMs).toBeGreaterThan(0);
      expect(blocked.resetMs).toBeLessThanOrEqual(1000);
    });

    it("keys are isolated per caller", () => {
      for (let i = 0; i < 3; i += 1) limiter.check("ip-A");
      expect(limiter.check("ip-A").allowed).toBe(false);
      expect(limiter.check("ip-B").allowed).toBe(true);
    });

    it("reset(key) wipes a single caller's counter", () => {
      for (let i = 0; i < 3; i += 1) limiter.check("ip-1");
      expect(limiter.check("ip-1").allowed).toBe(false);
      limiter.reset("ip-1");
      expect(limiter.check("ip-1").allowed).toBe(true);
    });

    it("clear() wipes every caller", () => {
      for (let i = 0; i < 3; i += 1) limiter.check("ip-1");
      for (let i = 0; i < 3; i += 1) limiter.check("ip-2");
      limiter.clear();
      expect(limiter.check("ip-1").allowed).toBe(true);
      expect(limiter.check("ip-2").allowed).toBe(true);
    });
  });

  it("re-allows after the window slides past old attempts", async () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 50 });
    limiter.check("ip-1");
    limiter.check("ip-1");
    expect(limiter.check("ip-1").allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(limiter.check("ip-1").allowed).toBe(true);
  });
});
