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
import { put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
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
        result = await postToInstagram(account, text, mediaUrl);
        break;
      case "youtube":
        result = {
          success: false,
          error: "youtube poster not yet ported — DEFERRED to follow-up session",
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
      const imgRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
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
// FB posts are allowed per rolling 24h window. Default = 1 (safe-by-
// default after the May 2026 page-suspension incident — too many posts
// triggers Meta's spam classifier and demotes reach). Set to 0 to
// disable. Throttle check uses a single COUNT(*) on marketing_posts.

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
  const dailyLimit = limitRaw === undefined ? 1 : Number.parseInt(limitRaw, 10);
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

  // Route to the right Graph endpoint based on media type.
  const isVideo =
    !!mediaUrl && (mediaUrl.includes(".mp4") || mediaUrl.toLowerCase().includes("video"));
  const graphBase = `https://graph.facebook.com/v21.0/${pageId}`;
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

  try {
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
    const postId = data.post_id ?? data.id;

    // Build the right public URL for the post type.
    let platformUrl: string | undefined;
    if (postId) {
      if (isVideo) {
        platformUrl = `https://www.facebook.com/${pageId}/videos/${postId.replace(`${pageId}_`, "")}`;
      } else if (mediaUrl) {
        platformUrl = `https://www.facebook.com/photo/?fbid=${postId.replace(`${pageId}_`, "")}`;
      } else if (postId.includes("_")) {
        const [pgId, pId] = postId.split("_");
        platformUrl = `https://www.facebook.com/${pgId}/posts/${pId}`;
      } else {
        platformUrl = `https://facebook.com/${postId}`;
      }
    }

    return { success: true, platformPostId: postId, platformUrl };
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
