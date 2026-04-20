import { createHmac, randomBytes } from "node:crypto";

export interface XAppCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export function getAppCredentials(): XAppCredentials {
  const consumerKey = process.env.X_CONSUMER_KEY;
  const consumerSecret = process.env.X_CONSUMER_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;

  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error(
      "X API credentials not configured — set X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET",
    );
  }

  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Builds an OAuth 1.0a Authorization header for X (Twitter) API v2.
 * Query parameters in `url` are automatically included in the signature.
 */
export function buildOAuth1Header(
  method: string,
  url: string,
  creds: XAppCredentials,
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Merge URL query params into the signature base
  const urlObj = new URL(url);
  const allParams: Record<string, string> = { ...oauthParams };
  urlObj.searchParams.forEach((v, k) => { allParams[k] = v; });

  const sortedParams = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join("&");

  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  const baseString = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(sortedParams)}`;

  const signingKey = `${pct(creds.consumerSecret)}&${pct(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParts = { ...oauthParams, oauth_signature: signature };
  const headerStr = Object.entries(headerParts)
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ");

  return `OAuth ${headerStr}`;
}
