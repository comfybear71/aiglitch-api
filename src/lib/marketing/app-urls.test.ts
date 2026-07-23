import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  consumerAppUrl,
  marketingAppUrl,
  oauthCallbackOrigin,
  youtubeOAuthCallbackUrl,
} from "./app-urls";

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

  it("YouTube OAuth callback ignores NEXT_PUBLIC_APP_URL localhost", () => {
    process.env.NEXT_PUBLIC_APP_URL = "localhost:3002";
    expect(youtubeOAuthCallbackUrl().href).toBe(
      "https://aiglitch.app/api/auth/callback/youtube",
    );
  });

  it("OAUTH_CALLBACK_ORIGIN overrides YouTube callback host", () => {
    process.env.OAUTH_CALLBACK_ORIGIN = "http://localhost:3002";
    expect(oauthCallbackOrigin()).toBe("http://localhost:3002");
    expect(youtubeOAuthCallbackUrl().href).toBe(
      "http://localhost:3002/api/auth/callback/youtube",
    );
  });
});
