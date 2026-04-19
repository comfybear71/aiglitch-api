import { describe, expect, it } from "vitest";
import {
  computeStatus,
  runHealth,
  type CheckResult,
  type HealthChecks,
} from "./health";

const ok = (optional: boolean, ms = 10): CheckResult => ({
  ok: true,
  latency_ms: ms,
  optional,
});

const fail = (optional: boolean, error = "boom"): CheckResult => ({
  ok: false,
  latency_ms: 0,
  optional,
  error,
});

const skipped = (): CheckResult => ({
  ok: true,
  latency_ms: 0,
  optional: true,
  skipped: true,
});

describe("computeStatus", () => {
  it("returns 'ok' when all checks pass", () => {
    expect(
      computeStatus({
        database: ok(false),
        redis: ok(true),
        xai: ok(true),
        anthropic: ok(true),
      })
    ).toBe("ok");
  });

  it("returns 'ok' when optional checks are skipped", () => {
    expect(
      computeStatus({
        database: ok(false),
        redis: skipped(),
        xai: skipped(),
        anthropic: skipped(),
      })
    ).toBe("ok");
  });

  it("returns 'degraded' when an optional check fails", () => {
    expect(
      computeStatus({
        database: ok(false),
        redis: fail(true),
        xai: ok(true),
        anthropic: ok(true),
      })
    ).toBe("degraded");
  });

  it("returns 'down' when a required check fails", () => {
    expect(
      computeStatus({
        database: fail(false, "DATABASE_URL not set"),
        redis: ok(true),
        xai: ok(true),
        anthropic: ok(true),
      })
    ).toBe("down");
  });

  it("prefers 'down' over 'degraded' when both required and optional fail", () => {
    expect(
      computeStatus({
        database: fail(false),
        redis: fail(true),
        xai: ok(true),
        anthropic: ok(true),
      })
    ).toBe("down");
  });
});

describe("runHealth", () => {
  const mocks = (overrides: Partial<HealthChecks> = {}): HealthChecks => ({
    database: async () => ok(false),
    redis: async () => ok(true),
    xai: async () => ok(true),
    anthropic: async () => ok(true),
    ...overrides,
  });

  it("produces a report with a timestamp and version", async () => {
    const report = await runHealth(mocks(), "9.9.9-test");
    expect(report.version).toBe("9.9.9-test");
    expect(typeof report.timestamp).toBe("string");
    expect(new Date(report.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("includes all four check names", async () => {
    const report = await runHealth(mocks());
    expect(Object.keys(report.checks).sort()).toEqual([
      "anthropic",
      "database",
      "redis",
      "xai",
    ]);
  });

  it("maps a failed required check to status 'down'", async () => {
    const report = await runHealth(
      mocks({ database: async () => fail(false, "connection refused") })
    );
    expect(report.status).toBe("down");
    expect(report.checks.database.error).toBe("connection refused");
  });

  it("maps a failed optional check to status 'degraded'", async () => {
    const report = await runHealth(
      mocks({ redis: async () => fail(true, "timeout") })
    );
    expect(report.status).toBe("degraded");
  });

  it("runs all checks in parallel (approximately)", async () => {
    const delay = (ms: number): Promise<CheckResult> =>
      new Promise((resolve) => setTimeout(() => resolve(ok(false, ms)), ms));
    const start = Date.now();
    await runHealth({
      database: () => delay(50),
      redis: () => delay(50),
      xai: () => delay(50),
      anthropic: () => delay(50),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(150);
  });
});
