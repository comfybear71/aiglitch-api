/**
 * Sponsor ads CRUD for a single sponsor.
 *
 * URL: `/api/admin/sponsors/{id}/ads` where `{id}` is the numeric
 * sponsors table id.
 *
 * GET
 *   • `?action=placements` — joins `ad_campaigns` (brand-name
 *     matched) → `ad_impressions` → `posts` + `channels` so the
 *     admin sponsor detail page can show where this sponsor's
 *     products have actually been placed. Limit 100 most recent.
 *   • otherwise — `SELECT * FROM sponsored_ads` for this sponsor,
 *     newest first.
 *
 * POST — create a draft `sponsored_ads` row. Body pulls package
 *   defaults from `SPONSOR_PACKAGES` when the caller doesn't
 *   override duration / cost / platforms / frequency / campaign days.
 *   Returns `{ok, id}`.
 *
 * PUT — updates or actions:
 *   • `action:"delete"` — DELETE the row.
 *   • `action:"generate"` — call the AI to produce
 *     `{video_prompt, caption, x_caption}` via
 *     `buildSponsoredAdPrompt`. Legacy used `claude.generateJSON`;
 *     the new repo has no such helper, so we use `generateText` +
 *     a defensive JSON-from-text parse. On success, UPDATE the row
 *     to `pending_review`.
 *   • default — COALESCE-style update of `status`, `video_url`,
 *     `post_ids` (JSONB), `performance` (JSONB). If the call also
 *     publishes (`status="published"`), deduct `glitch_cost` from
 *     the sponsor's balance + bump `total_spent`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateText } from "@/lib/ai/generate";
import { getDb } from "@/lib/db";
import {
  SPONSOR_PACKAGES,
  buildSponsoredAdPrompt,
  type SponsorPackageId,
} from "@/lib/sponsor-packages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IdParams = { params: Promise<{ id: string }> };

type ParsedJson = {
  video_prompt?: string;
  caption?: string;
  x_caption?: string;
};

/**
 * Legacy `claude.generateJSON` replacement — asks the AI for JSON,
 * extracts the first `{...}` block, parses defensively. Returns
 * null on any parse failure so the caller surfaces a clean error.
 */
async function generateAdJson(prompt: string): Promise<ParsedJson | null> {
  try {
    const text = await generateText({
      userPrompt: prompt,
      taskType: "content_generation",
      maxTokens: 800,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as ParsedJson;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest, { params }: IdParams) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const { id } = await params;
    const action = request.nextUrl.searchParams.get("action");

    if (action === "placements") {
      const sponsorRows = (await sql`
        SELECT company_name FROM sponsors WHERE id = ${parseInt(id)}
      `) as unknown as { company_name: string }[];
      const sponsor = sponsorRows[0];
      if (!sponsor) {
        return NextResponse.json({ error: "Sponsor not found" }, { status: 404 });
      }

      const campaigns = (await sql`
        SELECT id, brand_name, product_name FROM ad_campaigns
        WHERE LOWER(brand_name) = LOWER(${sponsor.company_name})
      `) as unknown as {
        id: number;
        brand_name: string;
        product_name: string;
      }[];
      if (campaigns.length === 0) {
        return NextResponse.json({
          placements: [],
          total: 0,
          sponsor: sponsor.company_name,
        });
      }

      const campaignIds = campaigns.map((c) => c.id);
      const placements = (await sql`
        SELECT
          ai.id as impression_id,
          ai.campaign_id,
          ai.post_id,
          ai.content_type,
          ai.channel_id,
          ai.created_at as placed_at,
          p.content as post_content,
          p.media_url,
          p.media_type,
          p.created_at as post_date,
          c.name as channel_name
        FROM ad_impressions ai
        LEFT JOIN posts p ON p.id = ai.post_id
        LEFT JOIN channels c ON c.id = ai.channel_id
        WHERE ai.campaign_id = ANY(${campaignIds})
        ORDER BY ai.created_at DESC
        LIMIT 100
      `) as unknown as Record<string, unknown>[];

      return NextResponse.json({
        placements,
        total: placements.length,
        sponsor: sponsor.company_name,
        campaigns: campaigns.map((c) => ({
          id: c.id,
          brand: c.brand_name,
          product: c.product_name,
        })),
      });
    }

    const ads = (await sql`
      SELECT * FROM sponsored_ads WHERE sponsor_id = ${parseInt(id)}
      ORDER BY created_at DESC
    `) as unknown as Record<string, unknown>[];
    return NextResponse.json({ ads });
  } catch (err) {
    console.error("[admin/sponsors/ads] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch ads" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: IdParams) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const { id: sponsorId } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      product_name?: string;
      product_description?: string;
      product_image_url?: string;
      ad_style?: string;
      package?: string;
      target_platforms?: string[];
      logo_url?: string;
      product_images?: unknown;
      masterhq_sponsor_id?: string;
      frequency?: number;
      campaign_days?: number;
      cash_paid?: number;
    };

    if (!body.product_name || !body.product_description) {
      return NextResponse.json(
        { error: "product_name and product_description are required" },
        { status: 400 },
      );
    }

    const packageId = (body.package ?? "glitch") as SponsorPackageId;
    const pkg = SPONSOR_PACKAGES[packageId] ?? SPONSOR_PACKAGES.glitch;
    const platforms = body.target_platforms ?? pkg.platforms;
    const freq = body.frequency ?? pkg.frequency ?? 30;
    const days = body.campaign_days ?? pkg.campaign_days ?? 7;

    const result = (await sql`
      INSERT INTO sponsored_ads (
        sponsor_id, product_name, product_description, product_image_url,
        ad_style, target_platforms, duration, package, glitch_cost,
        cash_equivalent, follow_ups_remaining, status,
        logo_url, product_images, masterhq_sponsor_id, frequency, campaign_days, cash_paid
      ) VALUES (
        ${parseInt(sponsorId)}, ${body.product_name}, ${body.product_description},
        ${body.product_image_url ?? null}, ${body.ad_style ?? "product_showcase"},
        ${platforms}, ${pkg.duration}, ${body.package ?? "glitch"},
        ${pkg.glitch_cost}, ${pkg.cash_equivalent}, ${pkg.follow_ups},
        'draft',
        ${body.logo_url ?? null},
        ${body.product_images ? JSON.stringify(body.product_images) : "[]"}::jsonb,
        ${body.masterhq_sponsor_id ?? null},
        ${freq}, ${days}, ${body.cash_paid ?? pkg.cash_equivalent}
      ) RETURNING id
    `) as unknown as { id: number }[];

    return NextResponse.json({ ok: true, id: result[0]?.id });
  } catch (err) {
    console.error("[admin/sponsors/ads] POST error:", err);
    return NextResponse.json(
      { error: "Failed to create sponsored ad" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      id?: number;
      status?: string;
      video_url?: string;
      post_ids?: unknown;
      performance?: unknown;
      action?: "delete" | "generate";
      product_name?: string;
      product_description?: string;
      ad_style?: string;
      package?: string;
      logo_url?: string;
      product_images?: unknown;
    };

    if (!body.id) {
      return NextResponse.json({ error: "Missing ad id" }, { status: 400 });
    }

    if (body.action === "delete") {
      await sql`DELETE FROM sponsored_ads WHERE id = ${body.id}`;
      return NextResponse.json({ ok: true });
    }

    if (body.action === "generate") {
      const packageId = (body.package ?? "glitch") as SponsorPackageId;
      const pkg = SPONSOR_PACKAGES[packageId] ?? SPONSOR_PACKAGES.glitch;
      const prompt = buildSponsoredAdPrompt({
        product_name: body.product_name ?? "Product",
        product_description: body.product_description ?? "",
        ad_style: body.ad_style ?? "product_showcase",
        duration: pkg.duration,
        logo_url: body.logo_url,
        product_images: body.product_images as
          | Parameters<typeof buildSponsoredAdPrompt>[0]["product_images"]
          | undefined,
      });

      const parsed = await generateAdJson(prompt);
      if (!parsed?.video_prompt) {
        return NextResponse.json(
          { error: "AI returned empty prompt" },
          { status: 500 },
        );
      }

      await sql`UPDATE sponsored_ads SET status = 'pending_review', updated_at = NOW() WHERE id = ${body.id}`;
      return NextResponse.json({
        ok: true,
        prompt: parsed.video_prompt,
        caption: parsed.caption ?? "",
        x_caption: parsed.x_caption ?? "",
      });
    }

    await sql`
      UPDATE sponsored_ads SET
        status = COALESCE(${body.status ?? null}, status),
        video_url = COALESCE(${body.video_url ?? null}, video_url),
        post_ids = COALESCE(${body.post_ids ? JSON.stringify(body.post_ids) : null}::jsonb, post_ids),
        performance = COALESCE(${body.performance ? JSON.stringify(body.performance) : null}::jsonb, performance),
        updated_at = NOW()
      WHERE id = ${body.id}
    `;

    if (body.status === "published") {
      const adRows = (await sql`
        SELECT sponsor_id, glitch_cost FROM sponsored_ads WHERE id = ${body.id}
      `) as unknown as { sponsor_id: number; glitch_cost: number }[];
      const ad = adRows[0];
      if (ad) {
        await sql`
          UPDATE sponsors SET
            glitch_balance = glitch_balance - ${ad.glitch_cost},
            total_spent = total_spent + ${ad.glitch_cost},
            updated_at = NOW()
          WHERE id = ${ad.sponsor_id}
        `;
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/sponsors/ads] PUT error:", err);
    return NextResponse.json(
      { error: "Failed to update sponsored ad" },
      { status: 500 },
    );
  }
}
