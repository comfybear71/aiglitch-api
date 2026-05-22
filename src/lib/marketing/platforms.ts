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
import { sendTelegramPhoto } from "@/lib/telegram";
import type { MarketingPlatform, PlatformAccount } from "./types";

/** Env var that overrides the DB access_token when set. */
const ENV_TOKEN_KEYS: Record<string, string> = {
  instagram: "INSTAGRAM_ACCESS_TOKEN",
  facebook: "FACEBOOK_ACCESS_TOKEN",
  telegram: "TELEGRAM_BOT_TOKEN",
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

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHANNEL_ID || process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    accounts.push({
      id: "env-telegram",
      platform: "telegram",
      account_name: "env",
      account_id: tgChatId,
      account_url: "",
      access_token: tgToken,
      refresh_token: "",
      token_expires_at: null,
      extra_config: "{}",
      is_active: true,
      last_posted_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  // X uses OAuth 1.0a app credentials (see src/lib/x-oauth.ts).
  // Create synthetic account if X env vars are configured.
  const xConsumerKey = process.env.X_CONSUMER_KEY;
  if (xConsumerKey) {
    accounts.push({
      id: "env-x",
      platform: "x",
      account_name: "env",
      account_id: "x-oauth1",
      account_url: "",
      access_token: "", // Not used for X (uses app creds instead)
      refresh_token: "",
      token_expires_at: null,
      extra_config: "{}",
      is_active: true,
      last_posted_at: null,
      created_at: now,
      updated_at: now,
    });
  }

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
      case "telegram":
        result = await postToTelegram(account, text, mediaUrl);
        break;
      case "facebook":
        result = await postToFacebook(account, text, mediaUrl);
        break;
      case "instagram":
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

// ── X poster (with media upload) ────────────────────────────────────────

async function uploadMediaToX(
  creds: ReturnType<typeof getAppCredentials>,
  mediaUrl: string,
): Promise<{ mediaId: string | null; error?: string }> {
  try {
    // Validate URL format
    if (!mediaUrl.startsWith("http")) {
      return { mediaId: null, error: "Invalid media URL" };
    }

    console.log(`[uploadMediaToX] Starting upload for ${mediaUrl.slice(0, 80)}...`);

    // Download media with timeout
    let mediaBuffer: Buffer;
    let mediaType: string;
    try {
      const imgRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(15000) });
      if (!imgRes.ok) {
        return {
          mediaId: null,
          error: `Download failed (${imgRes.status}): ${imgRes.statusText}`,
        };
      }
      mediaBuffer = Buffer.from(await imgRes.arrayBuffer());
      mediaType = imgRes.headers.get("content-type") || "image/jpeg";
      console.log(`[uploadMediaToX] Downloaded ${mediaBuffer.length} bytes (${mediaType})`);
    } catch (err) {
      return {
        mediaId: null,
        error: `Download error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // INIT: Start chunked upload
    const initUrl = new URL("https://upload.twitter.com/1.1/media/upload.json");
    initUrl.searchParams.set("command", "INIT");
    initUrl.searchParams.set("total_bytes", mediaBuffer.length.toString());
    initUrl.searchParams.set("media_type", mediaType);

    const initAuth = buildOAuth1Header("POST", initUrl.toString(), creds);
    const initRes = await fetch(initUrl.toString(), {
      method: "POST",
      headers: { Authorization: initAuth },
      signal: AbortSignal.timeout(10000),
    });

    if (!initRes.ok) {
      const body = await initRes.text();
      return {
        mediaId: null,
        error: `INIT failed (${initRes.status}): ${body.slice(0, 150)}`,
      };
    }

    const initData = (await initRes.json()) as {
      media_id_string?: string;
      error?: string;
    };
    const mediaId = initData.media_id_string;
    if (!mediaId) {
      return {
        mediaId: null,
        error: `INIT returned no media_id: ${JSON.stringify(initData)}`,
      };
    }
    console.log(`[uploadMediaToX] INIT OK, media_id=${mediaId}`);

    // APPEND: Upload media data (raw binary) with retries
    const appendUrl = new URL("https://upload.twitter.com/1.1/media/upload.json");
    appendUrl.searchParams.set("command", "APPEND");
    appendUrl.searchParams.set("media_id", mediaId);
    appendUrl.searchParams.set("segment_index", "0");

    let appendSuccess = false;
    let appendError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const appendAuth = buildOAuth1Header("POST", appendUrl.toString(), creds);
        const appendRes = await fetch(appendUrl.toString(), {
          method: "POST",
          headers: {
            Authorization: appendAuth,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(mediaBuffer),
          signal: AbortSignal.timeout(20000),
        });

        if (!appendRes.ok) {
          appendError = `${appendRes.status}: ${await appendRes.text()}`;
          console.warn(
            `[uploadMediaToX] APPEND attempt ${attempt + 1} failed: ${appendError.slice(0, 100)}`
          );
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        appendSuccess = true;
        console.log(`[uploadMediaToX] APPEND OK (attempt ${attempt + 1})`);
        break;
      } catch (err) {
        appendError = err instanceof Error ? err.message : String(err);
        console.warn(`[uploadMediaToX] APPEND attempt ${attempt + 1} exception: ${appendError}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!appendSuccess) {
      return { mediaId: null, error: `APPEND failed after 3 attempts: ${appendError}` };
    }

    // FINALIZE: Complete upload
    const finalizeUrl = new URL("https://upload.twitter.com/1.1/media/upload.json");
    finalizeUrl.searchParams.set("command", "FINALIZE");
    finalizeUrl.searchParams.set("media_id", mediaId);

    const finalizeAuth = buildOAuth1Header("POST", finalizeUrl.toString(), creds);
    const finalizeRes = await fetch(finalizeUrl.toString(), {
      method: "POST",
      headers: { Authorization: finalizeAuth },
      signal: AbortSignal.timeout(10000),
    });

    if (!finalizeRes.ok) {
      const body = await finalizeRes.text();
      return {
        mediaId: null,
        error: `FINALIZE failed (${finalizeRes.status}): ${body.slice(0, 150)}`,
      };
    }

    console.log(`[uploadMediaToX] FINALIZE OK, upload complete`);
    return { mediaId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[uploadMediaToX] Unexpected error: ${errorMsg}`);
    return { mediaId: null, error: errorMsg };
  }
}

async function postToX(
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  const creds = getAppCredentials();
  const tweetUrl = "https://api.twitter.com/2/tweets";
  const payload: Record<string, unknown> = { text };

  // Upload media if present
  if (mediaUrl && creds) {
    const uploadResult = await uploadMediaToX(creds, mediaUrl);
    if (uploadResult.mediaId) {
      payload.media = { media_ids: [uploadResult.mediaId] };
    } else {
      console.warn(`[postToX] Media upload failed: ${uploadResult.error}, posting text-only`);
    }
  }

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

// ── Facebook poster ────────────────────────────────────────────────────────

async function postToFacebook(
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  const accessToken = account.access_token;
  const pageId = account.account_id;

  if (!accessToken || !pageId) {
    return {
      success: false,
      error: "Missing Facebook access token or page ID",
    };
  }

  try {
    const graphUrl = `https://graph.facebook.com/v19.0/${pageId}/feed`;
    const payload: Record<string, unknown> = {
      message: text,
      access_token: accessToken,
    };

    if (mediaUrl) {
      payload.picture = mediaUrl;
      payload.link = mediaUrl;
    }

    const res = await fetch(graphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload as Record<string, string>).toString(),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "(unreadable)");
      return {
        success: false,
        error: `Facebook API ${res.status}: ${errBody.slice(0, 300)}`,
      };
    }

    const data = (await res.json()) as { id?: string };
    const postId = data.id;

    return {
      success: true,
      platformPostId: postId,
      platformUrl: postId ? `https://facebook.com/${postId}` : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: `Facebook error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Telegram poster ─────────────────────────────────────────────────────────

async function postToTelegram(
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  const botToken = account.access_token;
  const chatId = account.account_id;

  if (!botToken || !chatId) {
    return {
      success: false,
      error: "Missing Telegram bot token or chat ID",
    };
  }

  try {
    if (mediaUrl) {
      // Use download+multipart for media (Telegram can't reliably fetch Blob URLs)
      const result = await sendTelegramPhoto(botToken, chatId, mediaUrl, text);
      if (!result.ok) {
        return {
          success: false,
          error: `Telegram photo upload failed: ${result.error}`,
        };
      }
      return {
        success: true,
        platformPostId: result.messageId?.toString(),
        platformUrl: result.messageId
          ? `https://t.me/${account.account_name}/${result.messageId}`
          : undefined,
      };
    } else {
      // Text-only via JSON API
      const tgApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const res = await fetch(tgApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "(unreadable)");
        return {
          success: false,
          error: `Telegram API ${res.status}: ${errBody.slice(0, 300)}`,
        };
      }

      const data = (await res.json()) as {
        ok: boolean;
        result?: { message_id?: number };
      };
      const messageId = data.result?.message_id;

      return {
        success: data.ok,
        platformPostId: messageId?.toString(),
        platformUrl: messageId
          ? `https://t.me/${account.account_name}/${messageId}`
          : undefined,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Telegram error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
