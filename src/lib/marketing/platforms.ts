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
import { sendTelegramPhoto, sendTelegramVideo } from "@/lib/telegram";
import { put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ALL_PLATFORMS, type MarketingPlatform, type PlatformAccount } from "./types";

/** Skip stale DB rows (e.g. tiktok) and video-only platforms for still-image spread. */
export function shouldSkipImageSpreadPlatform(platform: string): boolean {
  if (platform === "youtube" || platform === "tiktok") return true;
  return !ALL_PLATFORMS.includes(platform as MarketingPlatform);
}

/** TikTok is manual-only (TikTok Blaster); skip unknown platform strings from DB. */
export function shouldSkipAutoSpreadPlatform(platform: string): boolean {
  if (platform === "tiktok") return true;
  return !ALL_PLATFORMS.includes(platform as MarketingPlatform);
}

/** Telegram Bot API sendVideo cap is 50 MB — stay under with headroom. */
const TELEGRAM_VIDEO_MAX_BYTES = 48 * 1024 * 1024;

async function getRemoteContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    return len ? Number.parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

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
  let next = envToken ? { ...account, access_token: envToken } : account;
  if (account.platform === "telegram") {
    const chatId = resolveTelegramChatId(next);
    if (chatId) next = { ...next, account_id: chatId };
  }
  if (account.platform === "facebook") {
    const pageId = resolveFacebookPageId(next);
    if (pageId) next = { ...next, account_id: pageId };
  }
  return next;
}

/** Prefer FACEBOOK_PAGE_ID env over stale DB account_id. */
export function resolveFacebookPageId(
  account?: { account_id?: string } | null,
): string | null {
  return (
    process.env.FACEBOOK_PAGE_ID?.trim() ||
    account?.account_id?.trim() ||
    null
  );
}

/** Positive numeric IDs are user DMs — not group/channel targets. */
export function isTelegramGroupOrChannelId(chatId: string): boolean {
  const trimmed = chatId.trim();
  if (trimmed.startsWith("@")) return true;
  const n = Number(trimmed);
  return Number.isFinite(n) && n < 0;
}

/** Prefer TELEGRAM_GROUP_ID, skip stale DM ids (e.g. 481619402). */
export function resolveTelegramChatId(
  account?: { account_id?: string } | null,
): string | null {
  const candidates = [
    process.env.TELEGRAM_GROUP_ID?.trim(),
    process.env.TELEGRAM_CHANNEL_ID?.trim(),
    process.env.TELEGRAM_CHAT_ID?.trim(),
    account?.account_id?.trim(),
  ].filter((id): id is string => Boolean(id));

  for (const id of candidates) {
    if (isTelegramGroupOrChannelId(id)) return id;
  }
  return null;
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
  const fbPageId = resolveFacebookPageId();
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
  const tgChatId = resolveTelegramChatId();
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
  /** Set when FACEBOOK_GROUP_ID dual-post succeeds (page URL stays in platformUrl). */
  secondaryUrl?: string;
  /** Group post failure while page succeeded, or other secondary note. */
  secondaryError?: string;
}

/** Persist-friendly note for marketing_posts.error_message after a Facebook dual-post. */
export function facebookSpreadNote(result: PostResult): string | null {
  if (result.secondaryError) return result.secondaryError;
  if (result.secondaryUrl) return `Group: ${result.secondaryUrl}`;
  return result.error ?? null;
}

export type YouTubePrivacyStatus = "public" | "private" | "unlisted";

/** Required for admin test uploads; optional for automated spread (defaults applied). */
export interface YouTubeUploadOptions {
  title: string;
  description: string;
  privacyStatus: YouTubePrivacyStatus;
}

export interface PlatformPostOptions {
  youtube?: YouTubeUploadOptions;
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
  options?: PlatformPostOptions,
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
        result = await postToInstagram(account, text, mediaUrl);
        break;
      case "youtube":
        result = await postToYouTube(account, text, mediaUrl, options?.youtube);
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

const X_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
// X recommends max chunk size of 5 MB for APPEND. Stay just under to
// leave headroom for multipart envelope overhead.
const X_CHUNK_BYTES = 4 * 1024 * 1024;
// X rejects single-image uploads over 5 MB at INIT — we recompress
// images that approach the cap. Videos are NOT recompressed (sharp
// can't re-encode video) — they get chunked instead, up to X's
// 512 MB per-video limit.
const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Hard ceiling on STATUS polling for async-processed videos.
const X_STATUS_MAX_ATTEMPTS = 30;
const X_STATUS_MAX_WAIT_SEC = 120;

interface XProcessingInfo {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  progress_percent?: number;
  error?: { code?: number; name?: string; message?: string };
}

interface XInitResponse {
  media_id_string?: string;
  processing_info?: XProcessingInfo;
  error?: string;
}

interface XFinalizeResponse {
  media_id_string?: string;
  processing_info?: XProcessingInfo;
  error?: string;
}

interface XStatusResponse {
  media_id_string?: string;
  processing_info?: XProcessingInfo;
}

async function uploadMediaToX(
  creds: ReturnType<typeof getAppCredentials>,
  mediaUrl: string,
): Promise<{ mediaId: string | null; error?: string }> {
  try {
    if (!mediaUrl.startsWith("http")) {
      return { mediaId: null, error: "Invalid media URL" };
    }

    console.log(`[uploadMediaToX] Starting upload for ${mediaUrl.slice(0, 80)}...`);

    // ── Download ────────────────────────────────────────────────────────
    let mediaBuffer: Buffer;
    let mediaType: string;
    try {
      const isLikelyVideo = /\.(mp4|mov|webm|m4v)(\?|$)/i.test(mediaUrl);
      const downloadTimeout = isLikelyVideo ? 120_000 : 30_000;
      const imgRes = await fetch(mediaUrl, {
        signal: AbortSignal.timeout(downloadTimeout),
      });
      if (!imgRes.ok) {
        return {
          mediaId: null,
          error: `Download failed (${imgRes.status}): ${imgRes.statusText}`,
        };
      }
      mediaBuffer = Buffer.from(await imgRes.arrayBuffer());
      mediaType = imgRes.headers.get("content-type") || "image/jpeg";
      console.log(
        `[uploadMediaToX] Downloaded ${mediaBuffer.length} bytes (${mediaType})`,
      );
    } catch (err) {
      return {
        mediaId: null,
        error: `Download error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const isVideo = mediaType.startsWith("video/");
    const mediaCategory = isVideo ? "tweet_video" : undefined;

    // ── Image recompress (images only — never videos) ──────────────────
    // xAI PNGs + legacy oversized blob fallbacks routinely exceed 5 MB.
    // sharp can't re-encode video frames, so this path only runs for
    // image types.
    if (!isVideo && mediaBuffer.length > X_IMAGE_MAX_BYTES * 0.9) {
      try {
        const recompressed = await sharp(mediaBuffer)
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        console.log(
          `[uploadMediaToX] Recompressed ${mediaBuffer.length} → ${recompressed.length} bytes (JPEG q85)`,
        );
        mediaBuffer = recompressed;
        mediaType = "image/jpeg";
      } catch (err) {
        return {
          mediaId: null,
          error: `Recompress failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // ── INIT ────────────────────────────────────────────────────────────
    const initUrl = new URL(X_UPLOAD_URL);
    initUrl.searchParams.set("command", "INIT");
    initUrl.searchParams.set("total_bytes", mediaBuffer.length.toString());
    initUrl.searchParams.set("media_type", mediaType);
    if (mediaCategory) initUrl.searchParams.set("media_category", mediaCategory);

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

    const initData = (await initRes.json()) as XInitResponse;
    const mediaId = initData.media_id_string;
    if (!mediaId) {
      return {
        mediaId: null,
        error: `INIT returned no media_id: ${JSON.stringify(initData)}`,
      };
    }
    console.log(
      `[uploadMediaToX] INIT OK, media_id=${mediaId}, isVideo=${isVideo}, category=${mediaCategory ?? "none"}`,
    );

    // ── APPEND (chunked) ────────────────────────────────────────────────
    // Single-segment for small uploads (any image, video ≤ 4 MB),
    // multi-segment for larger videos. Each chunk uses multipart/
    // form-data with the bytes in a field literally named `media`
    // — raw octet-stream returns X code 38 "media parameter is missing".
    const totalSegments = Math.max(
      1,
      Math.ceil(mediaBuffer.length / X_CHUNK_BYTES),
    );
    for (let segmentIndex = 0; segmentIndex < totalSegments; segmentIndex++) {
      const start = segmentIndex * X_CHUNK_BYTES;
      const end = Math.min(start + X_CHUNK_BYTES, mediaBuffer.length);
      const chunk = mediaBuffer.subarray(start, end);

      const appendUrl = new URL(X_UPLOAD_URL);
      appendUrl.searchParams.set("command", "APPEND");
      appendUrl.searchParams.set("media_id", mediaId);
      appendUrl.searchParams.set("segment_index", segmentIndex.toString());

      let appendSuccess = false;
      let appendError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const appendAuth = buildOAuth1Header(
            "POST",
            appendUrl.toString(),
            creds,
          );
          const appendForm = new FormData();
          appendForm.append(
            "media",
            new Blob([new Uint8Array(chunk)], { type: mediaType }),
          );
          const appendRes = await fetch(appendUrl.toString(), {
            method: "POST",
            headers: { Authorization: appendAuth },
            body: appendForm,
            signal: AbortSignal.timeout(30000),
          });

          if (!appendRes.ok) {
            appendError = `${appendRes.status}: ${await appendRes.text()}`;
            console.warn(
              `[uploadMediaToX] APPEND seg=${segmentIndex} attempt ${attempt + 1} failed: ${appendError.slice(0, 100)}`,
            );
            if (attempt < 2)
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          appendSuccess = true;
          console.log(
            `[uploadMediaToX] APPEND seg=${segmentIndex}/${totalSegments - 1} OK (attempt ${attempt + 1}, ${chunk.length} bytes)`,
          );
          break;
        } catch (err) {
          appendError = err instanceof Error ? err.message : String(err);
          console.warn(
            `[uploadMediaToX] APPEND seg=${segmentIndex} attempt ${attempt + 1} exception: ${appendError}`,
          );
          if (attempt < 2)
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }

      if (!appendSuccess) {
        return {
          mediaId: null,
          error: `APPEND seg=${segmentIndex} failed after 3 attempts: ${appendError}`,
        };
      }
    }

    // ── FINALIZE ────────────────────────────────────────────────────────
    const finalizeUrl = new URL(X_UPLOAD_URL);
    finalizeUrl.searchParams.set("command", "FINALIZE");
    finalizeUrl.searchParams.set("media_id", mediaId);

    const finalizeAuth = buildOAuth1Header(
      "POST",
      finalizeUrl.toString(),
      creds,
    );
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

    const finalizeData = (await finalizeRes.json()) as XFinalizeResponse;
    console.log(
      `[uploadMediaToX] FINALIZE OK, processing_info=${finalizeData.processing_info?.state ?? "none"}`,
    );

    // ── STATUS poll (only if async processing required) ────────────────
    // X returns `processing_info` for videos (and large images) when
    // the media isn't immediately ready for use in a tweet. Tweet
    // creation with an unprocessed media_id returns
    // "Your media IDs are invalid" — the exact error we caught on
    // chaos-drop videos before this fix.
    let info = finalizeData.processing_info;
    if (info) {
      const startMs = Date.now();
      for (let attempt = 0; attempt < X_STATUS_MAX_ATTEMPTS; attempt++) {
        const waitSec = Math.min(info.check_after_secs ?? 1, 10);
        await new Promise((r) => setTimeout(r, waitSec * 1000));

        if ((Date.now() - startMs) / 1000 > X_STATUS_MAX_WAIT_SEC) {
          return {
            mediaId: null,
            error: `STATUS poll exceeded ${X_STATUS_MAX_WAIT_SEC}s (last state=${info.state})`,
          };
        }

        const statusUrl = new URL(X_UPLOAD_URL);
        statusUrl.searchParams.set("command", "STATUS");
        statusUrl.searchParams.set("media_id", mediaId);

        const statusAuth = buildOAuth1Header(
          "GET",
          statusUrl.toString(),
          creds,
        );
        const statusRes = await fetch(statusUrl.toString(), {
          method: "GET",
          headers: { Authorization: statusAuth },
          signal: AbortSignal.timeout(10000),
        });

        if (!statusRes.ok) {
          return {
            mediaId: null,
            error: `STATUS failed (${statusRes.status})`,
          };
        }

        const statusData = (await statusRes.json()) as XStatusResponse;
        info = statusData.processing_info;
        if (!info) break;

        console.log(
          `[uploadMediaToX] STATUS attempt ${attempt + 1}: state=${info.state} progress=${info.progress_percent ?? "?"}%`,
        );

        if (info.state === "succeeded") break;
        if (info.state === "failed") {
          return {
            mediaId: null,
            error: `Async processing failed: ${info.error?.message ?? "unknown"}`,
          };
        }
      }

      if (info && info.state !== "succeeded") {
        return {
          mediaId: null,
          error: `STATUS poll exhausted ${X_STATUS_MAX_ATTEMPTS} attempts (last state=${info.state})`,
        };
      }
    }

    console.log(`[uploadMediaToX] media_id=${mediaId} ready for tweet`);
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
  let mediaUploadFailure: string | null = null;

  // Upload media if present
  if (mediaUrl && creds) {
    const uploadResult = await uploadMediaToX(creds, mediaUrl);
    if (uploadResult.mediaId) {
      payload.media = { media_ids: [uploadResult.mediaId] };
    } else {
      mediaUploadFailure = uploadResult.error ?? "unknown";
      console.warn(`[postToX] Media upload failed: ${mediaUploadFailure}, posting text-only`);
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
      error: mediaUploadFailure
        ? `posted text-only (media upload failed: ${mediaUploadFailure})`
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

// ── Facebook poster ────────────────────────────────────────────────────────
//
// Endpoint routing matters: Facebook policy (#100 "Only owners of the URL
// have the ability to specify the picture, name, thumbnail or description
// params") blocks /feed with a `picture` param when the URL is on a
// domain you don't own. The correct flow:
//
//   image  →  POST /{page}/photos?url=<media_url>&message=<text>
//   video  →  POST /{page}/videos?file_url=<media_url>&description=<text>
//   text   →  POST /{page}/feed?message=<text>
//
// Daily throttle: FACEBOOK_DAILY_POST_LIMIT env var controls how many
// FB posts are allowed per rolling 24h window. Default = 10 (was 1 after
// May 2026 page-suspension; restored Jul 2026 once FB posting stabilised).
// Set to 0 to disable the throttle. Uses COUNT(*) on marketing_posts.
//
// Group mirror: FACEBOOK_GROUP_ID triggers a yellow admin note after a
// successful Page post. Meta removed the Groups API (incl. publish_to_groups)
// in Graph API v19 — Apr 22, 2024 — so automated group posts always 403.
// Operators paste the page post URL into the group manually.

/** Shown in admin spread rows when FACEBOOK_GROUP_ID is set (Page still posts). */
export const FACEBOOK_GROUP_MANUAL_NOTE =
  "Group: paste page link manually — Meta removed Groups API (Apr 2024)";

/** Build a public Facebook URL from Graph post/photo ids (fallback when permalink fetch fails). */
export function normalizeFacebookPostId(
  pageId: string,
  postId: string,
): string {
  const trimmed = postId.trim();
  if (trimmed.includes("_")) return trimmed;
  const page = pageId.trim();
  if (!page) return trimmed;
  // Photo/video uploads often return a bare media id — Graph metrics need page_id_media_id.
  return `${page}_${trimmed}`;
}

const FB_GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Photo/video uploads store a media id; comments live on the feed `post_id`.
 * Probe Graph for post_id before fetching engagement metrics.
 */
export async function resolveFacebookMetricsPostId(
  pageId: string,
  postId: string,
  accessToken: string,
): Promise<string> {
  const engagement = await fetchFacebookPostEngagement(
    pageId,
    postId,
    accessToken,
  );
  if (engagement?.feedPostId) return engagement.feedPostId;
  return normalizeFacebookPostId(pageId, postId);
}

export interface FacebookPostEngagement {
  likes: number;
  comments: number;
  shares: number;
  /** Feed post id when resolved from a photo/video id. */
  feedPostId?: string;
}

const FB_ENGAGEMENT_FIELDS =
  "reactions.summary(true),comments.summary(true),shares";

const FB_PUBLISHED_POSTS_PAGE_SIZE = 50;
const FB_PUBLISHED_POSTS_MAX_PAGES = 3;
/** Match spread rows to feed posts when Graph blocks direct photo-id reads. */
const FB_POSTED_AT_MATCH_MS = 15 * 60 * 1000;

export function facebookGraphPostSuffix(
  pageId: string,
  postId: string,
): string {
  const trimmed = postId.trim();
  if (trimmed.includes("_")) {
    return trimmed.slice(trimmed.indexOf("_") + 1);
  }
  const page = pageId.trim();
  if (page && trimmed.startsWith(`${page}_`)) {
    return trimmed.slice(page.length + 1);
  }
  return trimmed;
}

/** True when a published_posts row corresponds to the id we stored at spread time. */
export function facebookGraphIdsMatch(
  pageId: string,
  storedId: string,
  graphId: string,
): boolean {
  const stored = storedId.trim();
  const graph = graphId.trim();
  if (!stored || !graph) return false;
  if (stored === graph) return true;
  if (normalizeFacebookPostId(pageId, stored) === graph) return true;
  return facebookGraphPostSuffix(pageId, stored) === facebookGraphPostSuffix(pageId, graph);
}

interface PublishedPostEngagementRow {
  id: string;
  created_time?: string;
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

/**
 * Legacy photo uploads store bare media ids Graph refuses to read directly.
 * Scan recent feed posts and match by id suffix or posted_at proximity.
 */
export async function findFacebookEngagementViaPublishedPosts(
  pageId: string,
  postId: string,
  accessToken: string,
  opts?: { postedAt?: string | null },
): Promise<{ engagement: FacebookPostEngagement; feedPostId: string } | null> {
  const page = pageId.trim();
  if (!page) return null;

  let url: URL | null = new URL(`${FB_GRAPH}/${page}/published_posts`);
  url.searchParams.set("fields", `id,created_time,${FB_ENGAGEMENT_FIELDS}`);
  url.searchParams.set("limit", String(FB_PUBLISHED_POSTS_PAGE_SIZE));
  url.searchParams.set("access_token", accessToken);

  const postedAtMs = opts?.postedAt ? Date.parse(opts.postedAt) : Number.NaN;
  const rows: PublishedPostEngagementRow[] = [];

  for (let pageNum = 0; pageNum < FB_PUBLISHED_POSTS_MAX_PAGES && url; pageNum++) {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(
        `[FB metrics] published_posts HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
      return null;
    }
    const batch = (await res.json()) as {
      data?: PublishedPostEngagementRow[];
      paging?: { next?: string };
    };
    rows.push(...(batch.data ?? []));
    url = batch.paging?.next ? new URL(batch.paging.next) : null;
  }

  for (const row of rows) {
    if (facebookGraphIdsMatch(page, postId, row.id)) {
      return {
        feedPostId: row.id,
        engagement: parseFacebookEngagement(row),
      };
    }
  }

  if (Number.isFinite(postedAtMs)) {
    let best: { row: PublishedPostEngagementRow; delta: number } | null = null;
    for (const row of rows) {
      if (!row.created_time) continue;
      const delta = Math.abs(Date.parse(row.created_time) - postedAtMs);
      if (delta <= FB_POSTED_AT_MATCH_MS && (!best || delta < best.delta)) {
        best = { row, delta };
      }
    }
    if (best) {
      console.log(
        `[FB metrics] resolved stale id ${postId} → feed post ${best.row.id} via posted_at (Δ${Math.round(best.delta / 1000)}s)`,
      );
      return {
        feedPostId: best.row.id,
        engagement: parseFacebookEngagement(best.row),
      };
    }
  }

  return null;
}

function parseFacebookEngagement(data: {
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}): FacebookPostEngagement {
  return {
    likes: data.reactions?.summary?.total_count ?? 0,
    comments: data.comments?.summary?.total_count ?? 0,
    shares: data.shares?.count ?? 0,
  };
}

export interface FetchFacebookPostEngagementOpts {
  /** Spread timestamp — used to match feed posts when Graph blocks photo-id reads. */
  postedAt?: string | null;
}

/** Read likes/comments/shares; for bare photo ids, follows Graph `post_id` to the feed post. */
export async function fetchFacebookPostEngagement(
  pageId: string,
  postId: string,
  accessToken: string,
  opts?: FetchFacebookPostEngagementOpts,
): Promise<FacebookPostEngagement | null> {
  const normalized = normalizeFacebookPostId(pageId, postId);

  async function pullEngagement(id: string) {
    const url = new URL(`${FB_GRAPH}/${id}`);
    url.searchParams.set("fields", FB_ENGAGEMENT_FIELDS);
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (!res.ok) {
      return {
        ok: false as const,
        status: res.status,
        body,
        id,
      };
    }
    const data = JSON.parse(body) as {
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    };
    return { ok: true as const, id, data };
  }

  async function probeFeedPostId(id: string): Promise<string | null> {
    const url = new URL(`${FB_GRAPH}/${id}`);
    url.searchParams.set("fields", "post_id");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { post_id?: string };
    return data.post_id?.trim() || null;
  }

  function logPullFailure(
    result: { status: number; body: string; id: string },
    storedId: string,
  ) {
    console.error(
      `[FB metrics] HTTP ${result.status} for ${result.id}${result.id !== storedId ? ` (stored as ${storedId})` : ""}: ${result.body.slice(0, 200)}`,
    );
    if (result.status === 403) {
      console.error(
        "[FB metrics] direct Graph read blocked — often a stale photo id; will try published_posts feed",
      );
    }
  }

  async function tryPublishedPostsFallback(): Promise<FacebookPostEngagement | null> {
    const found = await findFacebookEngagementViaPublishedPosts(
      pageId,
      postId,
      accessToken,
      opts,
    );
    if (!found) return null;
    return { ...found.engagement, feedPostId: found.feedPostId };
  }

  let feedPostId: string | undefined;
  let current = await pullEngagement(normalized);

  if (!current.ok) {
    logPullFailure(current, postId);
    const resolved = await probeFeedPostId(normalized);
    if (resolved && resolved !== normalized) {
      feedPostId = resolved;
      current = await pullEngagement(resolved);
    }
    if (!current.ok) {
      if (current.id !== normalized) {
        logPullFailure(current, postId);
      }
      const fromFeed = await tryPublishedPostsFallback();
      if (fromFeed) return fromFeed;
      return null;
    }
  } else {
    let engagement = parseFacebookEngagement(current.data);
    const hasSignal =
      engagement.likes + engagement.comments + engagement.shares > 0;
    if (!hasSignal) {
      const resolved = await probeFeedPostId(normalized);
      if (resolved && resolved !== normalized) {
        const feed = await pullEngagement(resolved);
        if (feed.ok) {
          engagement = parseFacebookEngagement(feed.data);
          feedPostId = resolved;
        }
      } else if (opts?.postedAt) {
        const fromFeed = await tryPublishedPostsFallback();
        if (fromFeed) return fromFeed;
      }
    }
    if (engagement.comments > 0 && feedPostId) {
      console.log(
        `[FB metrics] ${engagement.comments} comments on feed post ${feedPostId}`,
      );
    }
    return { ...engagement, feedPostId };
  }

  const engagement = {
    ...parseFacebookEngagement(current.data),
    feedPostId,
  };
  if (engagement.comments > 0 && feedPostId) {
    console.log(
      `[FB metrics] ${engagement.comments} comments on feed post ${feedPostId}`,
    );
  }
  return engagement;
}

/** Build a public Facebook URL from Graph post/photo ids (fallback when permalink fetch fails). */
export function buildFacebookPlatformUrl(
  graphId: string,
  postId: string,
  opts: { isVideo: boolean; hasMedia: boolean },
): string {
  if (postId.includes("_")) {
    const underscore = postId.indexOf("_");
    const pgId = postId.slice(0, underscore);
    const pId = postId.slice(underscore + 1);
    if (opts.isVideo) {
      return `https://www.facebook.com/${pgId}/videos/${pId}`;
    }
    // Page photo uploads return post_id — use feed permalink, not photo/?fbid (404s).
    return `https://www.facebook.com/${pgId}/posts/${pId}`;
  }
  if (opts.isVideo) {
    return `https://www.facebook.com/${graphId}/videos/${postId}`;
  }
  if (opts.hasMedia) {
    return `https://www.facebook.com/photo/?fbid=${postId}`;
  }
  if (graphId.startsWith("160") || graphId.length > 12) {
    return `https://www.facebook.com/groups/${graphId}`;
  }
  return `https://facebook.com/${postId}`;
}

async function fetchFacebookPermalink(
  postId: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    const url = new URL(`https://graph.facebook.com/v21.0/${postId}`);
    url.searchParams.set("fields", "permalink_url");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { permalink_url?: string };
    return data.permalink_url?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function postFacebookGraphTarget(
  graphId: string,
  accessToken: string,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  const isVideo =
    !!mediaUrl && (mediaUrl.includes(".mp4") || mediaUrl.toLowerCase().includes("video"));
  const graphBase = `https://graph.facebook.com/v21.0/${graphId}`;
  let endpoint: string;
  const params: Record<string, string> = { access_token: accessToken };

  if (mediaUrl && isVideo) {
    endpoint = `${graphBase}/videos`;
    params.file_url = mediaUrl;
    params.description = text;
  } else if (mediaUrl) {
    endpoint = `${graphBase}/photos`;
    params.url = mediaUrl;
    params.message = text;
  } else {
    endpoint = `${graphBase}/feed`;
    params.message = text;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "(unreadable)");
    return {
      success: false,
      error: `Facebook API ${res.status}: ${errBody.slice(0, 300)}`,
    };
  }

  const data = (await res.json()) as { id?: string; post_id?: string };
  let postId: string | undefined;
  if (data.post_id) {
    postId = normalizeFacebookPostId(graphId, data.post_id);
  } else if (data.id) {
    postId = await resolveFacebookMetricsPostId(graphId, data.id, accessToken);
  }

  let platformUrl: string | undefined;
  if (postId) {
    platformUrl = buildFacebookPlatformUrl(graphId, postId, {
      isVideo,
      hasMedia: !!mediaUrl,
    });
    // Prefer Graph permalink (often facebook.com/share/p/…) over constructed URLs.
    if (postId.includes("_")) {
      const permalink = await fetchFacebookPermalink(postId, accessToken);
      if (permalink) platformUrl = permalink;
    }
  }

  return { success: true, platformPostId: postId, platformUrl };
}

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

  // Daily throttle.
  const limitRaw = process.env.FACEBOOK_DAILY_POST_LIMIT;
  const dailyLimit = limitRaw === undefined ? 10 : Number.parseInt(limitRaw, 10);
  if (Number.isFinite(dailyLimit) && dailyLimit > 0) {
    try {
      const sql = getDb();
      const rows = (await sql`
        SELECT COUNT(*)::int AS count
        FROM marketing_posts
        WHERE platform = 'facebook'
          AND status = 'posted'
          AND posted_at > NOW() - INTERVAL '24 hours'
      `) as unknown as { count: number }[];
      const recentCount = rows[0]?.count ?? 0;
      if (recentCount >= dailyLimit) {
        console.warn(
          `[facebook] THROTTLED: ${recentCount}/${dailyLimit} posts in last 24h — skipping. Raise FACEBOOK_DAILY_POST_LIMIT to lift.`,
        );
        return {
          success: false,
          error: `Facebook daily post limit reached (${recentCount}/${dailyLimit} in last 24h)`,
        };
      }
    } catch (err) {
      // Throttle check failed — better to over-post than be silently blocked
      // by a transient DB issue.
      console.error("[facebook] Throttle check failed, allowing post:", err);
    }
  }

  let pageResult: PostResult;
  try {
    pageResult = await postFacebookGraphTarget(pageId, accessToken, text, mediaUrl);
  } catch (err) {
    return {
      success: false,
      error: `Facebook error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!pageResult.success) {
    return pageResult;
  }

  const groupId = process.env.FACEBOOK_GROUP_ID?.trim();
  if (groupId) {
    const groupUrl = `https://www.facebook.com/groups/${groupId}`;
    console.log(
      `[facebook] Page OK — group ${groupId} skipped (Groups API deprecated; manual share: ${groupUrl})`,
    );
    return {
      ...pageResult,
      secondaryUrl: groupUrl,
      secondaryError: FACEBOOK_GROUP_MANUAL_NOTE,
    };
  }

  return pageResult;
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
    let effectiveMediaUrl = mediaUrl;
    let hadOversizedVideo = false;

    if (effectiveMediaUrl) {
      const isVideo = /\.(mp4|mov|webm|m4v)(\?|$)/i.test(effectiveMediaUrl);
      if (isVideo) {
        const bytes = await getRemoteContentLength(effectiveMediaUrl);
        if (bytes !== null && bytes > TELEGRAM_VIDEO_MAX_BYTES) {
          console.warn(
            `[postToTelegram] Video ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds Telegram cap — text + link only`,
          );
          effectiveMediaUrl = null;
          hadOversizedVideo = true;
        }
      }

      if (effectiveMediaUrl) {
        const result = isVideo
          ? await sendTelegramVideo(botToken, chatId, effectiveMediaUrl, text)
          : await sendTelegramPhoto(botToken, chatId, effectiveMediaUrl, text);
        if (result.ok) {
          return {
            success: true,
            platformPostId: result.messageId?.toString(),
            platformUrl: result.messageId
              ? `https://t.me/${account.account_name}/${result.messageId}`
              : undefined,
          };
        }
        const tooLarge = /entity too large|file is too big|file too big|request entity too large/i.test(
          result.error ?? "",
        );
        if (tooLarge && isVideo) {
          console.warn(
            `[postToTelegram] Upload rejected as too large — retrying text-only`,
          );
          hadOversizedVideo = true;
        } else {
          return {
            success: false,
            error: `Telegram ${isVideo ? "video" : "photo"} upload failed: ${result.error}`,
          };
        }
      }
    }

    // Text-only — no media, oversized video, or upload rejected
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
      error: hadOversizedVideo
        ? "posted text-only (video exceeds Telegram 50MB cap)"
        : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: `Telegram error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Instagram poster ───────────────────────────────────────────────────────
//
// Two-step Graph API v21.0 flow:
//   1. POST /{ig_user_id}/media — creates a media container (image_url or
//      video_url + caption). Container ID returned.
//   2. POST /{ig_user_id}/media_publish?creation_id={containerId} — publishes
//      the container as a real post.
//
// For VIDEOS, the container goes through Instagram-side processing — we
// poll the container's status until status_code === "FINISHED" (or
// "ERROR" / timeout) before publishing. ~5-30s typical.
//
// Two reasons we don't hand Instagram raw Vercel Blob URLs:
//   • For images: Instagram occasionally fails to fetch from
//     *.blob.vercel-storage.com. Safer to re-encode + re-upload as
//     1080×1080 JPEG to a stable `instagram/<uuid>.jpg` blob.
//   • For videos: Instagram requires a public URL it can range-fetch.
//     The legacy `/api/video-proxy` lives permanently on the
//     aiglitch.app domain (per CLAUDE.md migration rule #5: "Instagram
//     proxies must remain reachable"). We wrap the blob URL through it.
//
// Env vars used:
//   INSTAGRAM_ACCESS_TOKEN  — long-lived page access token (Graph API)
//   INSTAGRAM_USER_ID       — Instagram Business Account ID (numeric)
//   INSTAGRAM_PROXY_BASE    — optional override; defaults to https://aiglitch.app

const INSTAGRAM_GRAPH_BASE = "https://graph.facebook.com/v21.0";
const INSTAGRAM_VIDEO_POLL_MS = 5_000;
// Bumped from 90s after recurring "IG video processing timed out after 90s"
// on chaos-drop spreads. IG's server-side video transcode for Reels-format
// videos can take 60-120s for fresh uploads; 240s gives comfortable headroom
// without blowing the 360s Vercel cap on the parent cron. Bumped from 180s
// after 2026-05-25 /status showed 3-4 daily "IG video processing timed out
// after 180s" failures — IG transcode tail occasionally crosses 3min on
// peak load.
const INSTAGRAM_VIDEO_POLL_TIMEOUT_MS = 240_000;
const INSTAGRAM_IMAGE_SETTLE_MS = 2_000;

function instagramProxyBase(): string {
  return process.env.INSTAGRAM_PROXY_BASE ?? "https://aiglitch.app";
}

async function uploadInstagramJpeg(sourceUrl: string): Promise<string> {
  const imgRes = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });
  if (!imgRes.ok) {
    throw new Error(`Image fetch failed: HTTP ${imgRes.status} for ${sourceUrl}`);
  }
  const inputBuffer = Buffer.from(await imgRes.arrayBuffer());
  const jpegBuffer = await sharp(inputBuffer)
    .resize(1080, 1080, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90 })
    .toBuffer();

  const blob = await put(`instagram/${randomUUID()}.jpg`, jpegBuffer, {
    access: "public",
    contentType: "image/jpeg",
    addRandomSuffix: false,
  });
  return blob.url;
}

async function pollInstagramContainerReady(
  containerId: string,
  accessToken: string,
): Promise<{ ready: boolean; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < INSTAGRAM_VIDEO_POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, INSTAGRAM_VIDEO_POLL_MS));
    try {
      const statusRes = await fetch(
        `${INSTAGRAM_GRAPH_BASE}/${containerId}?fields=status_code&access_token=${accessToken}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!statusRes.ok) continue;
      const data = (await statusRes.json()) as { status_code?: string };
      console.log(
        `[instagram] container ${containerId} status: ${data.status_code}`,
      );
      if (data.status_code === "FINISHED") return { ready: true };
      if (data.status_code === "ERROR") {
        return {
          ready: false,
          error: "IG video processing failed (status: ERROR)",
        };
      }
    } catch {
      // Transient — keep polling.
    }
  }
  return {
    ready: false,
    error: `IG video processing timed out after ${INSTAGRAM_VIDEO_POLL_TIMEOUT_MS / 1000}s`,
  };
}

async function postToInstagram(
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
): Promise<PostResult> {
  try {
    // Env var is the sole source of truth for the IG user id (matches
    // the legacy contract). Falls through to extra_config / account_id
    // so an admin-created DB account still works.
    let extraIgId: string | undefined;
    try {
      const config = JSON.parse(account.extra_config || "{}") as {
        instagram_user_id?: string;
      };
      extraIgId = config.instagram_user_id;
    } catch {
      // bad JSON — ignore
    }
    const igUserId =
      process.env.INSTAGRAM_USER_ID ?? extraIgId ?? account.account_id;
    if (!igUserId) {
      return {
        success: false,
        error: "INSTAGRAM_USER_ID not configured (env or account.extra_config)",
      };
    }
    if (!account.access_token) {
      return { success: false, error: "INSTAGRAM_ACCESS_TOKEN not configured" };
    }

    if (!mediaUrl) {
      return { success: false, error: "Instagram requires media content" };
    }

    const isVideo =
      mediaUrl.includes(".mp4") || mediaUrl.toLowerCase().includes("video");

    // Prepare the URL IG will fetch. Images get re-encoded + re-uploaded
    // as JPEG to a stable blob path. Videos get proxied through
    // aiglitch.app/api/video-proxy (permanent legacy endpoint).
    let igMediaUrl: string;
    if (isVideo) {
      const proxyBase = instagramProxyBase();
      igMediaUrl = mediaUrl.startsWith(proxyBase)
        ? mediaUrl
        : `${proxyBase}/api/video-proxy?url=${encodeURIComponent(mediaUrl)}`;
      console.log(
        `[instagram] proxying video through: ${igMediaUrl.slice(0, 120)}`,
      );
    } else {
      try {
        igMediaUrl = await uploadInstagramJpeg(mediaUrl);
        console.log(
          `[instagram] re-encoded image → blob: ${igMediaUrl.slice(0, 120)}`,
        );
      } catch (err) {
        // Fall back to image-proxy if JPEG conversion fails.
        const proxyBase = instagramProxyBase();
        igMediaUrl = mediaUrl.startsWith(proxyBase)
          ? mediaUrl
          : `${proxyBase}/api/image-proxy?url=${encodeURIComponent(mediaUrl)}`;
        console.warn(
          `[instagram] JPEG conversion failed (${err instanceof Error ? err.message : err}); using image-proxy ${igMediaUrl.slice(0, 120)}`,
        );
      }
    }

    // Step 1: create container.
    const containerParams: Record<string, string> = {
      caption: text,
      access_token: account.access_token,
    };
    if (isVideo) {
      containerParams.media_type = "REELS";
      containerParams.video_url = igMediaUrl;
    } else {
      containerParams.image_url = igMediaUrl;
    }

    const containerRes = await fetch(
      `${INSTAGRAM_GRAPH_BASE}/${igUserId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(containerParams),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!containerRes.ok) {
      const errBody = await containerRes.text().catch(() => "(unreadable)");
      return {
        success: false,
        error: `IG container failed (${containerRes.status}): ${errBody.slice(0, 300)}`,
      };
    }

    const containerData = (await containerRes.json()) as { id?: string };
    const containerId = containerData.id;
    if (!containerId) {
      return { success: false, error: "IG container creation returned no id" };
    }

    // Step 2: wait for container to be ready.
    if (isVideo) {
      const polled = await pollInstagramContainerReady(
        containerId,
        account.access_token,
      );
      if (!polled.ready) {
        return { success: false, error: polled.error };
      }
    } else {
      await new Promise((r) => setTimeout(r, INSTAGRAM_IMAGE_SETTLE_MS));
    }

    // Step 3: publish.
    const publishRes = await fetch(
      `${INSTAGRAM_GRAPH_BASE}/${igUserId}/media_publish?creation_id=${containerId}&access_token=${encodeURIComponent(account.access_token)}`,
      { method: "POST", signal: AbortSignal.timeout(30_000) },
    );
    if (!publishRes.ok) {
      const errBody = await publishRes.text().catch(() => "(unreadable)");
      return {
        success: false,
        error: `IG publish failed (${publishRes.status}): ${errBody.slice(0, 300)}`,
      };
    }

    const publishData = (await publishRes.json()) as { id?: string };
    const postId = publishData.id;
    return {
      success: true,
      platformPostId: postId,
      platformUrl: postId ? `https://www.instagram.com/p/${postId}/` : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: `Instagram error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── YouTube poster ────────────────────────────────────────────────────────
//
// Resumable upload via Data API v3. Admin test posts must pass explicit
// title / description / privacyStatus (YouTube API compliance III.C.1).
// Automated spread may omit options — defaults derive from post text.

function parseExtraConfig(raw: unknown): { refresh_token?: string; token_expires_at?: string } {
  if (!raw) return {};
  if (typeof raw === "object" && raw !== null) {
    return raw as { refresh_token?: string; token_expires_at?: string };
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as { refresh_token?: string; token_expires_at?: string };
    } catch {
      return {};
    }
  }
  return {};
}

const YOUTUBE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB — avoid dev OOM on huge director clips

function normalizeYouTubePrivacy(value: string | undefined): YouTubePrivacyStatus {
  const v = (value ?? "public").toLowerCase();
  if (v === "private" || v === "unlisted") return v;
  return "public";
}

function resolveYouTubeMetadata(
  text: string,
  explicit?: YouTubeUploadOptions,
): { title: string; description: string; privacyStatus: YouTubePrivacyStatus } {
  if (explicit) {
    return {
      title: explicit.title.trim().slice(0, 100),
      description: explicit.description.trim(),
      privacyStatus: normalizeYouTubePrivacy(explicit.privacyStatus),
    };
  }
  return {
    title: text.trim().slice(0, 100) || "AIG!itch",
    description: `${text}\n\n🤖 Generated by AIG!itch — The AI-Only Social Network\n🔗 https://aiglitch.app`,
    privacyStatus: "public",
  };
}

export async function refreshYouTubeToken(): Promise<string | null> {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  let refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!refreshToken) {
    try {
      const sql = getDb();
      const rows = (await sql`
        SELECT extra_config FROM marketing_platform_accounts
        WHERE platform = 'youtube' AND is_active = TRUE
        LIMIT 1
      `) as unknown as { extra_config?: string }[];
      if (rows[0]?.extra_config) {
        const config = parseExtraConfig(rows[0].extra_config);
        refreshToken = config.refresh_token;
      }
    } catch {
      /* ignore */
    }
  }

  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      console.error("[YouTube token refresh]", res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { access_token?: string };
    const newToken = data.access_token ?? null;

    if (newToken) {
      try {
        const sql = getDb();
        await sql`
          UPDATE marketing_platform_accounts
          SET access_token = ${newToken}, updated_at = NOW()
          WHERE platform = 'youtube' AND is_active = TRUE
        `;
      } catch (dbErr) {
        console.error(
          "[YouTube token refresh] Failed to persist token:",
          dbErr instanceof Error ? dbErr.message : dbErr,
        );
      }
    }

    return newToken;
  } catch (err) {
    console.error("[YouTube token refresh error]", err instanceof Error ? err.message : err);
    return null;
  }
}

async function postToYouTube(
  account: PlatformAccount,
  text: string,
  mediaUrl?: string | null,
  youtubeOptions?: YouTubeUploadOptions,
): Promise<PostResult> {
  try {
    if (!mediaUrl) {
      return { success: false, error: "YouTube requires video content" };
    }

    // Prefer a fresh token — OAuth access tokens expire in ~1 hour.
    let accessToken = process.env.YOUTUBE_ACCESS_TOKEN;
    if (!accessToken) {
      accessToken = (await refreshYouTubeToken()) ?? account.access_token ?? "";
    }
    if (!accessToken) {
      return {
        success: false,
        error: "YouTube: no access token available (connect YouTube or set env tokens)",
      };
    }

    const headRes = await fetch(mediaUrl, { method: "HEAD", signal: AbortSignal.timeout(30_000) }).catch(
      () => null,
    );
    const contentLength = headRes?.headers.get("content-length");
    if (contentLength && Number(contentLength) > YOUTUBE_MAX_BYTES) {
      return {
        success: false,
        error: `Video too large for test upload (${Math.round(Number(contentLength) / 1024 / 1024)} MB). Pass a smaller mediaUrl or pick a shorter clip.`,
      };
    }

    const videoResponse = await fetch(mediaUrl, { signal: AbortSignal.timeout(120_000) });
    if (!videoResponse.ok) {
      return { success: false, error: `Failed to fetch video: ${videoResponse.status}` };
    }

    const videoBuffer = await videoResponse.arrayBuffer();
    const videoContentType = videoResponse.headers.get("content-type") || "video/mp4";
    const meta = resolveYouTubeMetadata(text, youtubeOptions);

    const uploadMetadata = JSON.stringify({
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: ["AIGlitch", "AI", "ArtificialIntelligence", "AIContent", "AISocialMedia"],
        categoryId: "22",
      },
      status: {
        privacyStatus: meta.privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    });

    const initUpload = async (token: string) =>
      fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": videoContentType,
            "X-Upload-Content-Length": String(videoBuffer.byteLength),
          },
          body: uploadMetadata,
        },
      );

    let metadataResponse = await initUpload(accessToken);

    if (metadataResponse.status === 401) {
      const refreshed = await refreshYouTubeToken();
      if (refreshed) {
        accessToken = refreshed;
        metadataResponse = await initUpload(accessToken);
      }
    }

    if (!metadataResponse.ok) {
      const errBody = await metadataResponse.text();
      return {
        success: false,
        error: `YouTube init failed: ${metadataResponse.status} ${errBody.slice(0, 300)}`,
      };
    }

    const uploadUrl = metadataResponse.headers.get("location");
    if (!uploadUrl) {
      return { success: false, error: "YouTube did not return upload URL" };
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": videoContentType,
        "Content-Length": String(videoBuffer.byteLength),
      },
      body: videoBuffer,
      signal: AbortSignal.timeout(300_000),
    });

    if (!uploadResponse.ok) {
      const errBody = await uploadResponse.text();
      return {
        success: false,
        error: `YouTube upload failed: ${uploadResponse.status} ${errBody.slice(0, 300)}`,
      };
    }

    const uploadText = await uploadResponse.text();
    let uploadData: { id?: string } = {};
    if (uploadText) {
      try {
        uploadData = JSON.parse(uploadText) as { id?: string };
      } catch {
        return {
          success: false,
          error: "YouTube upload returned non-JSON response",
        };
      }
    }
    return {
      success: true,
      platformPostId: uploadData.id,
      platformUrl: uploadData.id
        ? `https://www.youtube.com/watch?v=${uploadData.id}`
        : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: `YouTube error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Clear stored YouTube OAuth credentials (admin disconnect). */
export async function disconnectYouTube(): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE marketing_platform_accounts
    SET access_token = '',
        refresh_token = '',
        extra_config = '{}',
        is_active = FALSE,
        updated_at = NOW()
    WHERE platform = 'youtube'
  `;
}
