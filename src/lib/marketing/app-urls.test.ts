import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { consumerAppUrl, marketingAppUrl } from "./app-urls";

describe("marketing app-urls", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("accepts localhost without scheme for NEXT_PUBLIC_APP_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "localhost:3002";
    expect(consumerAppUrl("/api/auth/callback/youtube").href).toBe(
      "http://localhost:3002/api/auth/callback/youtube",
    );
  });

  it("accepts localhost without scheme for MARKETING_APP_URL", () => {
    process.env.MARKETING_APP_URL = "localhost:3001";
    expect(marketingAppUrl("/marketing").href).toBe("http://localhost:3001/marketing");
  });
});
