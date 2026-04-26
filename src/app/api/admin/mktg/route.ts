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
  getActiveAccounts,
  getAnyAccountForPlatform,
  postToPlatform,
  testPlatformToken,
} from "@/lib/marketing/platforms";
import { ensureMarketingTables } from "@/lib/marketing/ensure-tables";
import type { MarketingPlatform } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const HERO_IMAGE_DEFERRED = {
  error:
    "Hero-image generators not yet ported (lib/marketing/hero-image — 513-line lib pending). Use the legacy admin in the meantime.",
};

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
    case "preview_poster_prompt":
      return NextResponse.json(HERO_IMAGE_DEFERRED, { status: 501 });

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
      const text =
        (body.message as string | undefined) ??
        `Test post from AIG!itch — ${new Date().toLocaleString()}`;
      const result = await postToPlatform(
        platform,
        account,
        text,
        (body.mediaUrl as string | undefined) ?? null,
      );
      return NextResponse.json({ ok: true, platform, ...result });
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

    case "generate_hero":
    case "generate_poster":
      return NextResponse.json(HERO_IMAGE_DEFERRED, { status: 501 });

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
