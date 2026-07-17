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

/** Consumer site base (OAuth callback URI host, legal pages). */
export function consumerAppUrl(path: string): URL {
  const base = normalizeBaseUrl(
    process.env.NEXT_PUBLIC_APP_URL,
    "https://aiglitch.app",
  );
  return new URL(path.startsWith("/") ? path : `/${path}`, base);
}
