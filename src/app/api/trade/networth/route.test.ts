import { describe, it, expect } from "vitest";

describe("/api/trade/networth", () => {
  it("schema module loads", async () => {
    const mod = await import("@/lib/trade/networth/db");
    expect(typeof mod.ensureNetWorthSchema).toBe("function");
  });
});
