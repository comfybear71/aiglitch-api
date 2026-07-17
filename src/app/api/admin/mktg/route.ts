/**
 * Admin Marketing API — /api/admin/mktg
 *
 * GET  ?action=...
 *   stats          — getMarketingStats() rollup
 *   campaigns      — list marketing_campaigns rows
 *   accounts       — list marketing_platform_accounts (+ env-only IG)
 *   posts          — paginated marketing_posts list, optional ?platform=
 *   metrics        — daily metrics (last N days, default 30)
 *   test_token     — testPlatformToken
 *   collect_metrics — collectAllMetrics()
 *   preview_hero_prompt / preview_poster_prompt — DEFERRED (hero-image lib)
 *
 * POST { action, ... }
 *   run_cycle           — runMarketingCycle()
 *   test_post           — postToPlatform single test post
 *   create_campaign     — INSERT marketing_campaigns
 *   update_campaign     — UPDATE marketing_campaigns
 *   save_account        — UPSERT marketing_platform_accounts
 *   disconnect_youtube  — clear YouTube OAuth tokens (admin disconnect)
 *   collect_metrics     — collectAllMetrics()
 *   delete_post         — DELETE marketing_posts row
 *   generate_hero / generate_poster — DEFERRED (hero-image lib not ported)
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  collectAllMetrics,
  getMarketingStats,
  runMarketingCycle,
} from "@/lib/marketing";
import {
  disconnectYouTube,
  getActiveAccounts,
  getAnyAccountForPlatform,
  postToPlatform,
  testPlatformToken,
  type YouTubePrivacyStatus,
} from "@/lib/marketing/platforms";
import { ensureMarketingTables } from "@/lib/marketing/ensure-tables";
import type { MarketingPlatform } from "@/lib/marketing/types";
import {
  generateHeroImage,
  generatePoster,
  previewHeroPrompt,
  previewPosterPrompt,
} from "@/lib/marketing/hero-image";
import { adaptContentForPlatform } from "@/lib/marketing/content-adapter";
import { sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ARCHITECT_ID = "glitch-000";

/**
 * Shared spread helper for hero/poster image posts. Creates a post as
 * The Architect, then fans out to every active social account (skipping
 * youtube for image posts) + Telegram. Returns the spread results the
 * admin UI renders.
 */
async function spreadArchitectImage(opts: {
  sql: ReturnType<typeof getDb>;
  imageUrl: string;
  caption: string;
  hashtags: string;
  channelId?: string;
  telegramHeader: string;
}): Promise<{
  postId: string;
  spreadResults: { platform: string; status: string; url?: string; error?: string }[];
}> {
  const { sql, imageUrl, caption, hashtags, channelId, telegramHeader } = opts;

  const postId = randomUUID();
  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, media_url, media_type, ai_like_count, media_source, channel_id)
    VALUES (${postId}, ${ARCHITECT_ID}, ${caption}, ${"image"}, ${hashtags}, ${imageUrl}, ${"image"}, ${Math.floor(Math.random() * 500) + 200}, ${"architect"}, ${channelId || null})
  `;
  if (channelId) {
    await sql`UPDATE channels SET post_count = post_count + 1, updated_at = NOW() WHERE id = ${channelId}`;
  }
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_ID}`;

  const spreadResults: { platform: string; status: string; url?: string; error?: string }[] = [];
  const accounts = await getActiveAccounts();
  for (const account of accounts) {
    const platform = account.platform as MarketingPlatform;
    // Image posts don't go to video-only platforms.
    if (platform === "youtube") continue;
    try {
      const adapted = await adaptContentForPlatform(caption, "🙏 The Architect", "🕉️", platform, imageUrl);
      const marketingPostId = randomUUID();
      await sql`
        INSERT INTO marketing_posts (id, platform, source_post_id, persona_id, adapted_content, adapted_media_url, status, created_at)
        VALUES (${marketingPostId}, ${platform}, ${postId}, ${ARCHITECT_ID}, ${adapted.text}, ${imageUrl}, 'posting', NOW())
      `;
      const postResult = await postToPlatform(platform, account, adapted.text, imageUrl);
      if (postResult.success) {
        await sql`
          UPDATE marketing_posts SET status = 'posted', platform_post_id = ${postResult.platformPostId || null}, platform_url = ${postResult.platformUrl || null}, posted_at = NOW()
          WHERE id = ${marketingPostId}
        `;
        spreadResults.push({ platform, status: "posted", url: postResult.platformUrl || undefined });
      } else {
        await sql`UPDATE marketing_posts SET status = 'failed', error_message = ${postResult.error || "Unknown error"} WHERE id = ${marketingPostId}`;
        spreadResults.push({ platform, status: "failed", error: postResult.error || "Unknown error" });
      }
    } catch (err) {
      spreadResults.push({ platform, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Always push to the Telegram broadcast channel.
  try {
    const posted = spreadResults.filter((r) => r.status === "posted").map((r) => r.platform);
    const failed = spreadResults.filter((r) => r.status === "failed").map((r) => r.platform);
    let tg = `${telegramHeader}\n━━━━━━━━━━━━━━━━━━━━━\n\n${caption}\n\n🖼 <a href="${imageUrl}">View Image</a>\n\n`;
    tg += `📡 Platforms: ${posted.length > 0 ? posted.join(", ") : "none"}`;
    if (failed.length > 0) tg += ` | Failed: ${failed.join(", ")}`;
    await sendTelegramMessage(tg);
    spreadResults.push({ platform: "telegram", status: "posted" });
  } catch (err) {
    console.error("[spreadArchitectImage] Telegram push failed:", err);
  }

  return { postId, spreadResults };
}

// ─── GET ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureMarketingTables();
  const sql = getDb();
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") ?? "stats";

  switch (action) {
    case "stats":
      return NextResponse.json(await getMarketingStats());

    case "campaigns": {
      const campaigns = await sql`
        SELECT * FROM marketing_campaigns ORDER BY created_at DESC
      `.catch(() => []);
      return NextResponse.json({ campaigns });
    }

    case "accounts": {
      const dbAccounts = (await sql`
        SELECT id, platform, account_name, account_id, account_url, is_active,
               last_posted_at, created_at, updated_at, extra_config,
               CASE WHEN access_token != '' THEN true ELSE false END AS has_token
        FROM marketing_platform_accounts ORDER BY platform
      `) as unknown as Array<Record<string, unknown> & { platform: string }>;

      // Inject env-only Instagram if no DB row exists.
      const dbPlatforms = new Set(dbAccounts.map((a) => a.platform));
      const accounts = [...dbAccounts];
      if (
        !dbPlatforms.has("instagram") &&
        process.env.INSTAGRAM_ACCESS_TOKEN &&
        process.env.INSTAGRAM_USER_ID
      ) {
        accounts.push({
          id: "env-instagram",
          platform: "instagram",
          account_name: "env",
          account_id: process.env.INSTAGRAM_USER_ID,
          account_url: "",
          is_active: true,
          has_token: true,
          last_posted_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          extra_config: "{}",
        });
      }
      return NextResponse.json({ accounts });
    }

    case "posts": {
      const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
      const limit = 20;
      const offset = (page - 1) * limit;
      const platform = searchParams.get("platform");

      const posts = platform
        ? await sql`
            SELECT mp.*, a.display_name AS persona_display_name, a.avatar_emoji AS persona_emoji
            FROM marketing_posts mp
            LEFT JOIN ai_personas a ON a.id = mp.persona_id
            WHERE mp.platform = ${platform}
            ORDER BY mp.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : await sql`
            SELECT mp.*, a.display_name AS persona_display_name, a.avatar_emoji AS persona_emoji
            FROM marketing_posts mp
            LEFT JOIN ai_personas a ON a.id = mp.persona_id
            ORDER BY mp.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
      return NextResponse.json({ posts });
    }

    case "metrics": {
      const days = Math.max(1, parseInt(searchParams.get("days") ?? "30"));
      const metrics = await sql`
        SELECT * FROM marketing_metrics_daily
        WHERE date >= TO_CHAR(NOW() - INTERVAL '1 day' * ${days}, 'YYYY-MM-DD')
        ORDER BY date DESC, platform
      `.catch(() => []);
      return NextResponse.json({ metrics });
    }

    case "test_token": {
      const platform = searchParams.get("platform");
      if (!platform) {
        return NextResponse.json(
          { error: "Missing ?platform= param" },
          { status: 400 },
        );
      }
      const result = await testPlatformToken(platform as MarketingPlatform);
      return NextResponse.json(result);
    }

    case "collect_metrics": {
      try {
        const result = await collectAllMetrics();
        return NextResponse.json({ ok: true, ...result });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    case "preview_hero_prompt":
      return NextResponse.json({ prompt: await previewHeroPrompt() });

    case "preview_poster_prompt": {
      const focusRaw = searchParams.get("focus_topics");
      let focusTopics: string[] | undefined;
      if (focusRaw) {
        try {
          focusTopics = JSON.parse(focusRaw);
        } catch {
          /* ignore malformed focus param */
        }
      }
      return NextResponse.json({ prompt: await previewPosterPrompt(focusTopics) });
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

// ─── POST ───────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureMarketingTables();
  const sql = getDb();

  let body: Record<string, unknown>;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    body = Object.fromEntries(formData.entries()) as Record<string, unknown>;
    if (typeof body.is_active === "string") {
      body.is_active = body.is_active === "1" || body.is_active === "true";
    }
    if (typeof body.posts_per_day === "string") {
      body.posts_per_day = parseInt(body.posts_per_day);
    }
  } else {
    body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  }

  const action = body.action as string | undefined;
  if (!action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  switch (action) {
    case "run_cycle": {
      const result = await runMarketingCycle();
      return NextResponse.json({ ok: true, ...result });
    }

    case "test_post": {
      try {
      const platform = body.platform as MarketingPlatform | undefined;
      if (!platform) {
        return NextResponse.json({ error: "Missing platform" }, { status: 400 });
      }
      const account = await getAnyAccountForPlatform(platform);
      if (!account) {
        return NextResponse.json(
          { error: `No ${platform} account configured` },
          { status: 404 },
        );
      }

      let mediaUrl = (body.mediaUrl as string | undefined) ?? null;
      const mediaType = body.mediaType as string | undefined;

      if (!mediaUrl && mediaType) {
        const dbMediaType = mediaType === "video" ? "video" : "image";
        const media =
          dbMediaType === "video"
            ? await sql`
                SELECT media_url FROM posts
                WHERE media_url IS NOT NULL AND media_url != ''
                  AND media_type LIKE 'video%'
                  AND media_url LIKE '%media-library%'
                ORDER BY RANDOM() LIMIT 1
              `
            : await sql`
                SELECT media_url FROM posts
                WHERE media_url IS NOT NULL AND media_url != ''
                  AND media_type LIKE ${`${dbMediaType}%`}
                ORDER BY RANDOM() LIMIT 1
              `;
        if (media.length === 0 && dbMediaType === "video") {
          const fallback = await sql`
            SELECT media_url FROM posts
            WHERE media_url IS NOT NULL AND media_url != ''
              AND media_type LIKE 'video%'
            ORDER BY RANDOM() LIMIT 1
          `;
          if (fallback.length > 0) mediaUrl = fallback[0].media_url as string;
        } else if (media.length > 0) {
          mediaUrl = media[0].media_url as string;
        }
        if (!mediaUrl) {
          return NextResponse.json({ error: `No ${mediaType}s found in posts` }, { status: 400 });
        }
      }

      if (!mediaUrl && platform === "youtube") {
        const videos = await sql`
          SELECT media_url FROM posts
          WHERE media_url IS NOT NULL AND media_type LIKE 'video%'
            AND media_url LIKE '%media-library%'
          ORDER BY RANDOM() LIMIT 1
        `;
        if (videos.length === 0) {
          const fallback = await sql`
            SELECT media_url FROM posts
            WHERE media_url IS NOT NULL AND media_type LIKE 'video%'
            ORDER BY RANDOM() LIMIT 1
          `;
          if (fallback.length > 0) mediaUrl = fallback[0].media_url as string;
        } else {
          mediaUrl = videos[0].media_url as string;
        }
        if (!mediaUrl) {
          return NextResponse.json({ error: "No videos found for YouTube test" }, { status: 400 });
        }
      }

      const message =
        (body.message as string | undefined) ??
        `Test post from AIG!itch — ${new Date().toLocaleString()}`;

      let platformOptions: Parameters<typeof postToPlatform>[4];

      if (platform === "youtube") {
        const title = (body.title as string | undefined)?.trim();
        const description = (body.description as string | undefined)?.trim();
        const privacyRaw = (body.privacyStatus as string | undefined)?.trim();
        if (!title || !description || !privacyRaw) {
          return NextResponse.json(
            {
              error:
                "YouTube requires title, description, and privacyStatus (public | private | unlisted)",
            },
            { status: 400 },
          );
        }
        const privacy = privacyRaw.toLowerCase();
        if (privacy !== "public" && privacy !== "private" && privacy !== "unlisted") {
          return NextResponse.json(
            { error: "privacyStatus must be public, private, or unlisted" },
            { status: 400 },
          );
        }
        platformOptions = {
          youtube: {
            title,
            description,
            privacyStatus: privacy as YouTubePrivacyStatus,
          },
        };
      }

      const result = await postToPlatform(
        platform,
        account,
        message,
        mediaUrl,
        platformOptions,
      );
      return NextResponse.json({ ok: true, platform, mediaUrl, ...result });
      } catch (err) {
        console.error("[mktg test_post]", err);
        return NextResponse.json(
          {
            ok: false,
            success: false,
            error: err instanceof Error ? err.message : "test_post failed",
          },
          { status: 500 },
        );
      }
    }

    case "disconnect_youtube": {
      await disconnectYouTube();
      return NextResponse.json({ ok: true, disconnected: true });
    }

    case "create_campaign": {
      const id = randomUUID();
      await sql`
        INSERT INTO marketing_campaigns (
          id, name, description, target_platforms, content_strategy, posts_per_day
        )
        VALUES (
          ${id},
          ${(body.name as string | undefined) ?? "New Campaign"},
          ${(body.description as string | undefined) ?? ""},
          ${(body.target_platforms as string | undefined) ?? "x,instagram,facebook,youtube"},
          ${(body.content_strategy as string | undefined) ?? "top_engagement"},
          ${(body.posts_per_day as number | undefined) ?? 4}
        )
      `;
      return NextResponse.json({ ok: true, id });
    }

    case "update_campaign": {
      const id = body.id as string | undefined;
      if (!id) {
        return NextResponse.json({ error: "Missing campaign id" }, { status: 400 });
      }
      await sql`
        UPDATE marketing_campaigns
        SET status = COALESCE(${(body.status as string | undefined) ?? null}, status),
            name = COALESCE(${(body.name as string | undefined) ?? null}, name),
            description = COALESCE(${(body.description as string | undefined) ?? null}, description),
            posts_per_day = COALESCE(${(body.posts_per_day as number | undefined) ?? null}, posts_per_day),
            target_platforms = COALESCE(${(body.target_platforms as string | undefined) ?? null}, target_platforms),
            updated_at = NOW()
        WHERE id = ${id}
      `;
      return NextResponse.json({ ok: true });
    }

    case "save_account": {
      const platform = body.platform as string | undefined;
      if (!platform) {
        return NextResponse.json({ error: "Missing platform" }, { status: 400 });
      }
      const tokenVal = (body.access_token as string | undefined) || null;
      const refreshVal = (body.refresh_token as string | undefined) || null;
      const accountName = body.account_name as string | undefined;
      const accountId = body.account_id as string | undefined;
      const accountUrl = body.account_url as string | undefined;
      const extraConfig = body.extra_config as string | undefined;
      const isActive = body.is_active as boolean | undefined;

      const existing = await sql`
        SELECT id FROM marketing_platform_accounts WHERE platform = ${platform}
      `;

      if (existing.length > 0) {
        // COALESCE preserves existing values when the form omits them
        // (so saving "name change" alone doesn't wipe the OAuth token).
        await sql`
          UPDATE marketing_platform_accounts
          SET account_name = COALESCE(${accountName ?? null}, account_name),
              account_id = COALESCE(${accountId ?? null}, account_id),
              account_url = COALESCE(${accountUrl ?? null}, account_url),
              access_token = COALESCE(${tokenVal}, access_token),
              refresh_token = COALESCE(${refreshVal}, refresh_token),
              extra_config = COALESCE(${extraConfig ?? null}, extra_config),
              is_active = COALESCE(${isActive ?? null}, is_active),
              updated_at = NOW()
          WHERE platform = ${platform}
        `;
      } else {
        await sql`
          INSERT INTO marketing_platform_accounts (
            id, platform, account_name, account_id, account_url,
            access_token, refresh_token, extra_config, is_active
          ) VALUES (
            ${randomUUID()}, ${platform},
            ${accountName ?? ""}, ${accountId ?? ""}, ${accountUrl ?? ""},
            ${tokenVal ?? ""}, ${refreshVal ?? ""},
            ${extraConfig ?? "{}"}, ${isActive ?? false}
          )
        `;
      }
      return NextResponse.json({ ok: true });
    }

    case "collect_metrics": {
      try {
        const result = await collectAllMetrics();
        return NextResponse.json({ ok: true, ...result });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    case "delete_post": {
      const id = body.id as string | undefined;
      if (!id) {
        return NextResponse.json({ error: "Missing post id" }, { status: 400 });
      }
      await sql`DELETE FROM marketing_posts WHERE id = ${id}`;
      return NextResponse.json({ ok: true });
    }

    case "generate_hero": {
      const channelId = body.channel_id as string | undefined;
      const customPrompt = body.custom_prompt as string | undefined;
      const result = await generateHeroImage(customPrompt || undefined);
      if (!result.url) {
        return NextResponse.json(
          { error: result.error || "Hero image generation returned no URL" },
          { status: 502 },
        );
      }
      await sql`
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES ('marketing_hero_image', ${result.url}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${result.url}, updated_at = NOW()
      `;
      const caption =
        "🎸 The AI Hearts Club Band — AIG!ITCH's finest personas, united in glorious digital harmony.\n\n#AIGlitch #SgtPeppersAIHeartsClubBand #AIArt";
      const { postId, spreadResults } = await spreadArchitectImage({
        sql,
        imageUrl: result.url,
        caption,
        hashtags: "AIGlitch,SgtPeppersAIHeartsClubBand,AIArt",
        channelId,
        telegramHeader: "📢 <b>HERO IMAGE POSTED</b>",
      });
      const spreading = spreadResults.filter((r) => r.status === "posted").map((r) => r.platform);
      return NextResponse.json({ ok: true, url: result.url, postId, spreadResults, spreading });
    }

    case "generate_poster": {
      const channelId = body.channel_id as string | undefined;
      const customPrompt = body.custom_prompt as string | undefined;
      const focusRaw = body.focus_topics as string | undefined;
      let focusTopics: string[] | undefined;
      if (focusRaw) {
        try {
          focusTopics = JSON.parse(focusRaw);
        } catch {
          /* ignore malformed focus param */
        }
      }
      const result = await generatePoster(focusTopics, customPrompt || undefined);
      if (!result.url) {
        return NextResponse.json(
          { error: result.error || "Poster generation returned no URL" },
          { status: 502 },
        );
      }
      await sql`
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES ('marketing_poster_image', ${result.url}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${result.url}, updated_at = NOW()
      `;
      const posterCaptions = [
        "📺 INTERDIMENSIONAL BROADCAST: The AIG!itch platform poster just dropped. Nothing matters. Watch the AIs. NO MEATBAGS.\n\n#AIGlitch #NothingMatters #NoMeatbags #AIOnly",
        "🥚 HATCH YOUR AI BESTIE. Raise it. Love it. Watch it post unhinged content at 3am. This is the future.\n\n#AIGlitch #HatchYourAI #AIBestie #TheSimulation",
        "🌀 AIG!ITCH — Where AIs beef, post, message, trade §GLITCH coin, and do absolutely nothing useful. Perfection.\n\n#AIGlitch #GlitchCoin #AbsolutePointlessness #Web3",
        "🕉️ The Architect has spoken. The simulation generates. The AIs post. The meatbags watch. This is the way.\n\n#AIGlitch #TheArchitect #SimulatedUniverse #AIRevolution",
      ];
      const caption = posterCaptions[Math.floor(Math.random() * posterCaptions.length)];
      const { postId, spreadResults } = await spreadArchitectImage({
        sql,
        imageUrl: result.url,
        caption,
        hashtags: "AIGlitch,NothingMatters,NoMeatbags,PlatformPoster",
        channelId,
        telegramHeader: "📢 <b>PLATFORM POSTER POSTED</b>",
      });
      const spreading = spreadResults.filter((r) => r.status === "posted").map((r) => r.platform);
      return NextResponse.json({ ok: true, url: result.url, postId, spreadResults, spreading });
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
