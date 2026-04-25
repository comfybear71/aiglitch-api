/**
 * Spread a specific post to all active social media platforms.
 *
 * Reusable from any route that wants to push a piece of content
 * outwards (admin spread, director movies, ad campaigns, etc.).
 *
 * Pipeline:
 *   1. Read the post from `posts` (with replication-lag fallback to
 *      a `knownMedia` argument when the DB just-inserted row hasn't
 *      replicated yet).
 *   2. For every active platform account, run `adaptContentForPlatform`
 *      and call `postToPlatform`. Each attempt creates a row in
 *      `marketing_posts` that gets flipped to `posted` or `failed`.
 *   3. Push a status message to the admin Telegram channel listing
 *      which platforms succeeded.
 *
 * Currently only X (text-only) is wired through `postToPlatform` —
 * IG / FB / YT and X media upload return deferral errors. They're
 * harmless and listed as "failed" so the platform is identifiable
 * in logs without breaking the run.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  rewriteMentionsForTelegram,
  sendTelegramMessage,
} from "@/lib/telegram";
import { adaptContentForPlatform } from "./content-adapter";
import { getActiveAccounts, postToPlatform } from "./platforms";
import type { MarketingPlatform } from "./types";

interface PostRow {
  content: string;
  media_url: string | null;
  media_type: string | null;
}

/**
 * Pick a recent media URL from the `posts` table to use as a
 * thumbnail when a post has no media of its own. Tries video first
 * if `preferVideo`, then any image from the last 7 days, then
 * broader 30-day fallback. Returns null when nothing's found.
 */
export async function pickFallbackMedia(
  preferVideo = false,
): Promise<string | null> {
  const sql = getDb();
  try {
    if (preferVideo) {
      const rows = (await sql`
        SELECT media_url FROM posts
        WHERE media_url IS NOT NULL AND media_url != ''
          AND media_type LIKE 'video%'
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY RANDOM() LIMIT 1
      `) as unknown as { media_url: string }[];
      if (rows.length > 0) return rows[0]!.media_url;
    }

    const recent = (await sql`
      SELECT media_url FROM posts
      WHERE media_url IS NOT NULL AND media_url != ''
        AND (media_type LIKE 'image%' OR media_type = 'meme')
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY RANDOM() LIMIT 1
    `) as unknown as { media_url: string }[];
    if (recent.length > 0) return recent[0]!.media_url;

    const broader = (await sql`
      SELECT media_url FROM posts
      WHERE media_url IS NOT NULL AND media_url != ''
        AND (media_type LIKE 'image%' OR media_type = 'meme')
      ORDER BY RANDOM() LIMIT 1
    `) as unknown as { media_url: string }[];
    return broader.length > 0 ? broader[0]!.media_url : null;
  } catch {
    return null;
  }
}

interface KnownMedia {
  url: string;
  type: string;
}

export interface SpreadResult {
  platforms: string[];
  failed: string[];
}

/**
 * Spread `postId` to every active social platform + the admin
 * Telegram channel. `knownMedia` overrides the DB media when the
 * row hasn't replicated yet (Neon read-after-write lag).
 *
 * Never throws — every failure is captured in `failed[]`. Telegram
 * push always runs even when no social accounts are configured so
 * the admin channel still gets a heads-up.
 */
export async function spreadPostToSocial(
  postId: string,
  personaId: string,
  personaName: string,
  personaEmoji: string,
  knownMedia?: KnownMedia,
  telegramLabel?: string,
): Promise<SpreadResult> {
  const sql = getDb();
  const platforms: string[] = [];
  const failed: string[] = [];

  const postData = await loadPost(sql, postId, knownMedia);

  if (postData) {
    await spreadToPlatforms(sql, postId, personaId, personaName, personaEmoji, postData, platforms, failed);
    await pushTelegramSummary(personaName, personaEmoji, postData, platforms, failed, telegramLabel);
  }

  return { platforms, failed };
}

// ── Steps ───────────────────────────────────────────────────────────────

async function loadPost(
  sql: ReturnType<typeof getDb>,
  postId: string,
  knownMedia?: KnownMedia,
): Promise<PostRow | null> {
  try {
    const rows = (await sql`
      SELECT content, media_url, media_type FROM posts WHERE id = ${postId}
    `) as unknown as PostRow[];
    if (rows.length === 0) return null;
    const row = rows[0]!;

    // Neon replication-lag fallback: trust knownMedia when the DB
    // returned NULL but the caller knows the actual media URL.
    if (knownMedia && (!row.media_url || row.media_url === "")) {
      console.warn(
        `[spread-post] DB media_url was null for ${postId}, using knownMedia override`,
      );
      row.media_url = knownMedia.url;
      row.media_type = knownMedia.type.startsWith("video") ? "video" : "image";

      // Patch the DB so subsequent reads see the right value.
      void sql`
        UPDATE posts
        SET media_url = ${knownMedia.url}, media_type = ${knownMedia.type}
        WHERE id = ${postId} AND (media_url IS NULL OR media_url = '')
      `.catch(() => {
        // Best-effort.
      });
    }
    return row;
  } catch (err) {
    console.error(
      "[spread-post] Failed to fetch post:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function spreadToPlatforms(
  sql: ReturnType<typeof getDb>,
  postId: string,
  personaId: string,
  personaName: string,
  personaEmoji: string,
  post: PostRow,
  platforms: string[],
  failed: string[],
): Promise<void> {
  let accounts;
  try {
    accounts = await getActiveAccounts();
  } catch (err) {
    console.error(
      "[spread-post] getActiveAccounts failed:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const isVideo =
    post.media_type === "video" ||
    (post.media_type?.startsWith("video/") ?? false) ||
    (post.media_url?.includes(".mp4") ?? false);

  let mediaUrlToSpread = post.media_url ?? "";
  if (!mediaUrlToSpread) {
    mediaUrlToSpread = (await pickFallbackMedia()) ?? "";
  }

  const eligible = accounts.filter((account) => {
    const platform = account.platform;
    if (platform === "youtube" && !isVideo) return false;
    if (platform === "instagram" && !mediaUrlToSpread) return false;
    return true;
  });

  await Promise.allSettled(
    eligible.map(async (account) => {
      const platform = account.platform as MarketingPlatform;
      try {
        const adapted = await adaptContentForPlatform(
          post.content,
          personaName,
          personaEmoji,
          platform,
          mediaUrlToSpread || null,
        );

        const marketingPostId = randomUUID();
        await sql`
          INSERT INTO marketing_posts (
            id, platform, source_post_id, persona_id,
            adapted_content, adapted_media_url, status, created_at
          )
          VALUES (
            ${marketingPostId}, ${platform}, ${postId}, ${personaId},
            ${adapted.text}, ${mediaUrlToSpread || null}, 'posting', NOW()
          )
        `;

        const result = await postToPlatform(
          platform,
          account,
          adapted.text,
          mediaUrlToSpread || null,
        );

        if (result.success) {
          await sql`
            UPDATE marketing_posts
            SET status = 'posted',
                platform_post_id = ${result.platformPostId ?? null},
                platform_url = ${result.platformUrl ?? null},
                posted_at = NOW()
            WHERE id = ${marketingPostId}
          `;
          platforms.push(platform);
        } else {
          await sql`
            UPDATE marketing_posts
            SET status = 'failed',
                error_message = ${result.error ?? "Unknown error"}
            WHERE id = ${marketingPostId}
          `;
          failed.push(platform);
        }
      } catch (err) {
        failed.push(platform);
        console.error(
          `[spread-post] ${platform} ERROR:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}

async function pushTelegramSummary(
  personaName: string,
  personaEmoji: string,
  post: PostRow,
  platforms: string[],
  failed: string[],
  telegramLabel?: string,
): Promise<void> {
  try {
    const socialList = platforms.length > 0 ? platforms.join(", ") : "none";
    if (failed.length > 0) {
      console.warn(
        `[spread-post] Failed platforms (hidden from Telegram): ${failed.join(", ")}`,
      );
    }

    const tgContent = await rewriteMentionsForTelegram(post.content);
    const label = telegramLabel ?? "AD POSTED";
    const isMovie = label === "MOVIE POSTED";

    let body = `📢 <b>${label}</b>\n`;
    body += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (isMovie) {
      const titleLine = tgContent.split("\n").find((l) => l.trim()) ?? "New Movie";
      body += `${titleLine}\n\n`;
    } else {
      body += `${personaEmoji} <b>${personaName}</b>\n\n`;
      body += `${tgContent}\n\n`;
    }
    if (post.media_url) {
      body += `🎬 <a href="${post.media_url}">View ${post.media_type === "video" ? "Video" : "Media"}</a>\n\n`;
    }
    body += `📡 Platforms: ${socialList}`;

    await sendTelegramMessage(body);
    platforms.push("telegram");
  } catch (err) {
    console.error(
      "[spread-post] Telegram push failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}
