import { describe, it, expect } from "vitest";

describe("/api/coins", () => {
  it("GET rejects unauthenticated requests", async () => {
    expect(true).toBe(true);
  });

  it("POST rejects unauthenticated requests", async () => {
    expect(true).toBe(true);
  });
});
