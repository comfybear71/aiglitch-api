function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/$/, "");
  if (!trimmed) return fallback;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Allow localhost:3002 style values in .env.local without throwing in `new URL()`.
  return `http://${trimmed}`;
}

/** Post-OAuth redirects for marketing admin tools (YouTube connect, etc.). */
export function marketingAppUrl(path: string): URL {
  const base = normalizeBaseUrl(
    process.env.MARKETING_APP_URL,
    "https://marketing.aiglitch.app",
  );
  return new URL(path.startsWith("/") ? path : `/${path}`, base);
}

/** Consumer site base (legal pages, deep links). */
export function consumerAppUrl(path: string): URL {
  const base = normalizeBaseUrl(
    process.env.NEXT_PUBLIC_APP_URL,
    "https://aiglitch.app",
  );
  return new URL(path.startsWith("/") ? path : `/${path}`, base);
}

/**
 * OAuth redirect host for Google/YouTube callbacks.
 *
 * Always `https://aiglitch.app` in production. Do NOT reuse
 * `NEXT_PUBLIC_APP_URL` here — local dev often sets that to localhost for
 * unrelated features, which sends Google to the wrong port/app.
 *
 * Override with `OAUTH_CALLBACK_ORIGIN` only when running the consumer
 * site locally AND its `/api/auth/callback/youtube` rewrite hits this API.
 */
export function oauthCallbackOrigin(): string {
  return normalizeBaseUrl(
    process.env.OAUTH_CALLBACK_ORIGIN,
    "https://aiglitch.app",
  );
}

export function youtubeOAuthCallbackUrl(): URL {
  return new URL("/api/auth/callback/youtube", oauthCallbackOrigin());
}
