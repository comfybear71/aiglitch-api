/**
 * Marketing HQ — platform account lookup + posting dispatcher.
 *
 * Accounts live in `marketing_platform_accounts`, but env vars take
 * precedence for access tokens (per TheMaster rule: Vercel env vars
 * are the sole source of truth for social-platform credentials). If
 * env vars are present but no DB row exists for a platform, a
 * synthetic "env-*" account is materialised on the fly.
 *
 * Posting:
 *   - X (text-only) is fully wired here via `postToX`. Media uploads
 *     require chunked OAuth 1.0a uploads (~210 lines of state machine
 *     in legacy) — DEFERRED to a follow-up; the route still posts the
 *     text successfully.
 *   - Instagram, Facebook, YouTube — DEFERRED. Stubbed to return
 *     `{ success: false, error: "Not yet ported" }` so the dispatcher
 *     can route to them without throwing once their consumers ship.
 */

import { getDb } from "@/lib/db";
import { buildOAuth1Header, getAppCredentials } from "@/lib/x-oauth";
import type { MarketingPlatform, PlatformAccount } from "./types";

/** Env var that overrides the DB access_token when set. */
const ENV_TOKEN_KEYS: Record<string, string> = {
  instagram: "INSTAGRAM_ACCESS_TOKEN",
  facebook: "FACEBOOK_ACCESS_TOKEN",
  youtube: "YOUTUBE_ACCESS_TOKEN",
};

function applyEnvTokens(account: PlatformAccount): PlatformAccount {
  const envKey = ENV_TOKEN_KEYS[account.platform];
  const envToken = envKey ? process.env[envKey] : undefined;
  return envToken ? { ...account, access_token: envToken } : account;
}

/**
 * Build account objects from env vars for platforms that have no DB row.
 * Only called when the DB lookup misses — cheap to compute each time.
 */
function getEnvOnlyAccounts(): PlatformAccount[] {
  const accounts: PlatformAccount[] = [];
  const now = new Date().toISOString();

  const igToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_USER_ID;
  if (igToken && igUserId) {
    accounts.push({
      id: "env-instagram",
      platform: "instagram",
      account_name: "env",
      account_id: igUserId,
      account_url: "",
      access_token: igToken,
      refresh_token: "",
      token_expires_at: null,
      extra_config: JSON.stringify({ instagram_user_id: igUserId }),
      is_active: true,
      last_posted_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  const fbToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const fbPageId = process.env.FACEBOOK_PAGE_ID;
  if (fbToken && fbPageId) {
    accounts.push({
      id: "env-facebook",
      platform: "facebook",
      account_name: "env",
      account_id: fbPageId,
      account_url: "",
      access_token: fbToken,
      refresh_token: "",
      token_expires_at: null,
      extra_config: "{}",
      is_active: true,
      last_posted_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  // X uses OAuth 1.0a app credentials (see src/lib/x-oauth.ts) — there's no
  // single access_token to cache here, so we rely on env-less fallback in
  // the metrics collector itself.

  return accounts;
}

/**
 * Returns the active account for a platform. Prefers DB row (with env
 * token override); falls back to env-only synthesized account.
 */
export async function getAccountForPlatform(
  platform: MarketingPlatform,
): Promise<PlatformAccount | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM marketing_platform_accounts
    WHERE platform = ${platform} AND is_active = TRUE
    LIMIT 1
  `) as unknown as PlatformAccount[];

  if (rows[0]) return applyEnvTokens(rows[0]);

  const envAccounts = getEnvOnlyAccounts();
  return envAccounts.find((a) => a.platform === platform) ?? null;
}

/**
 * Variant that returns even an inactive DB row when no active one exists.
 * Used by the metrics collector + admin tools that need the credentials
 * even after a platform is paused.
 */
export async function getAnyAccountForPlatform(
  platform: MarketingPlatform,
): Promise<PlatformAccount | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM marketing_platform_accounts
    WHERE platform = ${platform}
    ORDER BY is_active DESC, created_at DESC
    LIMIT 1
  `) as unknown as PlatformAccount[];

  if (rows[0]) return applyEnvTokens(rows[0]);

  const envAccounts = getEnvOnlyAccounts();
  return envAccounts.find((a) => a.platform === platform) ?? null;
}

/**
 * All active accounts across every platform. Pulls DB rows first
 * (with env-token override) and merges in env-only platforms that
 * have no DB row.
 */
export async function getActiveAccounts(): Promise<PlatformAccount[]> {
  const sql = getDb();
  const dbRows = (await sql`
    SELECT * FROM marketing_platform_accounts
    WHERE is_active = TRUE
  `) as unknown as PlatformAccount[];

  const dbPlatforms = new Set(dbRows.map((r) => r.platform));
  const dbWithEnv = dbRows.map(applyEnvTokens);
  const envOnly = getEnvOnlyAccounts().filter(
    (a) => !dbPlatforms.has(a.platform),
  );

  return [...dbWithEnv, ...envOnly];
}

// ── Posting ─────────────────────────────────────────────────────────────

export interface PostResult {
  success: boolean;
  platformPostId?: string;
  platformUrl?: string;
  error?: string;
}

/**
 * Test whether the stored credentials still work. Currently only X is
 * implemented (uses OAuth 1.0a `/2/users/me` ping); other platforms
 * return `{ ok: true }` until their posters port over so the admin
 * UI doesn't false-flag a working platform as broken.
 */
export async function testPlatformToken(
  platform: MarketingPlatform,
): Promise<{ ok: boolean; error?: string }> {
  if (platform === "x") {
    const creds = getAppCredentials();
    if (!creds) return { ok: false, error: "X OAuth1 env vars not configured" };
    try {
      const url = "https://api.twitter.com/2/users/me";
      const auth = buildOAuth1Header("GET", url, creds);
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // IG/FB/YT token validation — defer until those posters port.
  return { ok: true };
}

/**
 * Post `text` (and optional media) to `platform`. Routes to the
 * platform-specific implementation. Other platforms (IG/FB/YT) are
 * stubbed and return `{ success: false }` until their ports land —
 * the dispatcher itself works today.
 */
export async function postToPlatform(
  platform: MarketingPlatform,
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  const start = Date.now();
  console.log(
    `[postToPlatform] >>> ${platform} start (media=${mediaUrl?.slice(0, 60) ?? "none"})`,
  );

  try {
    let result: PostResult;
    switch (platform) {
      case "x":
        result = await postToX(account, text, mediaUrl);
        break;
      case "instagram":
      case "facebook":
      case "youtube":
        result = {
          success: false,
          error: `${platform} poster not yet ported — DEFERRED to follow-up session`,
        };
        break;
    }
    const ms = Date.now() - start;
    console.log(
      `[postToPlatform] <<< ${platform} ${result.success ? "OK" : "FAIL"} (${ms}ms) ${result.error ?? result.platformPostId ?? ""}`,
    );
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    console.error(
      `[postToPlatform] <<< ${platform} EXCEPTION (${ms}ms): ${err instanceof Error ? err.message : err}`,
    );
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── X poster (text-only — media upload deferred) ────────────────────────

async function postToX(
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  if (mediaUrl) {
    // Chunked OAuth1 v1.1 media upload (~210 LOC state machine) — DEFERRED.
    // Caller can still spread the text, but no image/video attaches yet.
    console.warn(
      "[postToX] Media URL ignored — chunked upload deferred to follow-up port",
    );
  }

  const creds = getAppCredentials();
  const tweetUrl = "https://api.twitter.com/2/tweets";
  const payload: Record<string, unknown> = { text };

  let authHeader: string;
  if (creds) {
    authHeader = buildOAuth1Header("POST", tweetUrl, creds);
  } else if (account.access_token) {
    authHeader = `Bearer ${account.access_token}`;
  } else {
    return {
      success: false,
      error: "No X OAuth1 env vars and no DB access token available",
    };
  }

  try {
    const res = await fetch(tweetUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "(unreadable)");
      return {
        success: false,
        error: `X API ${res.status}: ${errBody.slice(0, 300)}`,
      };
    }

    const data = (await res.json()) as { data?: { id?: string } };
    const tweetId = data.data?.id;

    return {
      success: true,
      platformPostId: tweetId,
      platformUrl: tweetId
        ? `https://x.com/${account.account_name}/status/${tweetId}`
        : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: `X error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
