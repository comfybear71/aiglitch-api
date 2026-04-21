/**
 * Admin CRUD for the sponsored ad-campaign engine.
 *
 *   GET                        — list all campaigns + per-campaign
 *                                logged impression counts. Auto-expires
 *                                past-due active campaigns first.
 *   GET ?action=stats          — overview stats (counts by status,
 *                                total impressions, lifetime GLITCH
 *                                revenue, expired-this-run count).
 *
 *   POST { action, ... } — everything mutating goes through here:
 *     - "create"       → pending_payment, auto-generated id
 *     - "activate"     → sets status=active, paid_at, starts_at,
 *                        expires_at (+duration_days from row)
 *     - "pause" / "resume" / "cancel" / "complete"
 *     - "reactivate"   → re-dates a completed/cancelled campaign
 *     - "update"       → partial COALESCE update by campaign_id
 *     - "impressions"  → last 100 ad_impressions rows with post context
 *     - "seed_inhouse" → idempotent seed of 6 in-house products (energy
 *                        drink, repellent, pre-cracked screens, etc.).
 *                        Updates logos if rows already exist.
 *
 * Schema safety: the full `ad_campaigns` + `ad_impressions` tables are
 * created on every call so fresh envs work. We skip the legacy's
 * 15-ALTER-TABLE migration block — every environment we care about
 * has either the new schema (via CREATE) or the old one (queries that
 * reference new columns will surface errors loudly; run a proper
 * migration outside this route if that ever happens).
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { expireCompletedCampaigns } from "@/lib/ad-campaigns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const INHOUSE_BLOB_BASE = "https://jug8pwv8lcpdrski.public.blob.vercel-storage.com/sponsors";

async function ensureSchema(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS ad_campaigns (
      id                   TEXT         PRIMARY KEY,
      brand_name           TEXT         NOT NULL,
      product_name         TEXT         NOT NULL,
      product_emoji        TEXT         DEFAULT '📦',
      visual_prompt        TEXT         NOT NULL,
      text_prompt          TEXT,
      logo_url             TEXT,
      product_image_url    TEXT,
      product_images       JSONB        DEFAULT '[]',
      website_url          TEXT,
      target_channels      JSONB,
      target_persona_types JSONB,
      status               TEXT         DEFAULT 'pending_payment',
      duration_days        INTEGER      DEFAULT 7,
      price_glitch         INTEGER      DEFAULT 10000,
      frequency            REAL         DEFAULT 0.3,
      grokify_scenes       INTEGER      DEFAULT 3,
      grokify_mode         TEXT         DEFAULT 'all',
      impressions          INTEGER      DEFAULT 0,
      video_impressions    INTEGER      DEFAULT 0,
      image_impressions    INTEGER      DEFAULT 0,
      post_impressions     INTEGER      DEFAULT 0,
      is_inhouse           BOOLEAN      DEFAULT FALSE,
      last_burn_at         TIMESTAMPTZ,
      notes                TEXT,
      created_by           TEXT,
      paid_at              TIMESTAMPTZ,
      starts_at            TIMESTAMPTZ,
      expires_at           TIMESTAMPTZ,
      created_at           TIMESTAMPTZ  DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  DEFAULT NOW()
    )
  `.catch(() => {});
  await sql`
    CREATE TABLE IF NOT EXISTS ad_impressions (
      id           TEXT        PRIMARY KEY,
      campaign_id  TEXT        NOT NULL,
      post_id      TEXT,
      content_type TEXT        DEFAULT 'text',
      channel_id   TEXT,
      persona_id   TEXT,
      prompt_used  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `.catch(() => {});
}

// ── GET ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSchema();
    const sql = getDb();
    const action = request.nextUrl.searchParams.get("action");
    const expired = await expireCompletedCampaigns();

    if (action === "stats") {
      const [total] = (await sql`SELECT COUNT(*)::int AS count FROM ad_campaigns`) as unknown as [{ count: number }];
      const [active] = (await sql`
        SELECT COUNT(*)::int AS count FROM ad_campaigns
        WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
      `) as unknown as [{ count: number }];
      const [imps] = (await sql`
        SELECT COALESCE(SUM(impressions), 0)::int AS total FROM ad_campaigns
      `) as unknown as [{ total: number }];
      const [revenue] = (await sql`
        SELECT COALESCE(SUM(price_glitch), 0)::int AS total FROM ad_campaigns
        WHERE status IN ('active', 'completed')
      `) as unknown as [{ total: number }];

      return NextResponse.json({
        stats: {
          total:              total.count,
          active:             active.count,
          totalImpressions:   imps.total,
          totalRevenueGlitch: revenue.total,
          expiredThisRun:     expired,
        },
      });
    }

    const campaigns = await sql`
      SELECT c.*,
        (SELECT COUNT(*) FROM ad_impressions WHERE campaign_id = c.id) AS total_logged_impressions
      FROM ad_campaigns c
      ORDER BY
        CASE c.status
          WHEN 'active'          THEN 0
          WHEN 'pending_payment' THEN 1
          WHEN 'paused'          THEN 2
          ELSE 3
        END,
        c.created_at DESC
    `;

    return NextResponse.json({ campaigns, expiredThisRun: expired });
  } catch (err) {
    console.error("[admin/ad-campaigns] GET:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── POST: action router ────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  duration_days: number | null;
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSchema();
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action as string | undefined;

    if (action === "create") return handleCreate(sql, body);
    if (action === "activate") return handleActivate(sql, body);
    if (action === "update") return handleUpdate(sql, body);
    if (action === "impressions") return handleImpressions(sql, body);
    if (action === "seed_inhouse") return handleSeedInhouse(sql);
    if (action === "pause" || action === "resume" || action === "cancel" ||
        action === "reactivate" || action === "complete") {
      return handleStatusChange(sql, action, body);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[admin/ad-campaigns] POST:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function handleCreate(sql: ReturnType<typeof getDb>, body: Record<string, unknown>) {
  const brand_name = body.brand_name as string | undefined;
  const product_name = body.product_name as string | undefined;
  const visual_prompt = body.visual_prompt as string | undefined;

  if (!brand_name || !product_name || !visual_prompt) {
    return NextResponse.json(
      { error: "brand_name, product_name, and visual_prompt are required" },
      { status: 400 },
    );
  }

  const target_channels = body.target_channels ? JSON.stringify(body.target_channels) : null;
  const target_persona_types = body.target_persona_types ? JSON.stringify(body.target_persona_types) : null;

  const id = randomUUID();
  await sql`
    INSERT INTO ad_campaigns (
      id, brand_name, product_name, product_emoji, visual_prompt, text_prompt,
      logo_url, product_image_url, website_url, target_channels, target_persona_types,
      status, duration_days, price_glitch, frequency, notes, created_by, created_at, updated_at
    ) VALUES (
      ${id}, ${brand_name}, ${product_name},
      ${(body.product_emoji as string) ?? "📦"},
      ${visual_prompt},
      ${(body.text_prompt as string) ?? null},
      ${(body.logo_url as string) ?? null},
      ${(body.product_image_url as string) ?? null},
      ${(body.website_url as string) ?? null},
      ${target_channels}, ${target_persona_types},
      'pending_payment',
      ${(body.duration_days as number) ?? 7},
      ${(body.price_glitch as number) ?? 10000},
      ${(body.frequency as number) ?? 0.3},
      ${(body.notes as string) ?? null},
      'admin', NOW(), NOW()
    )
  `;

  return NextResponse.json({ success: true, campaign_id: id, status: "pending_payment" });
}

async function handleActivate(sql: ReturnType<typeof getDb>, body: Record<string, unknown>) {
  const campaign_id = body.campaign_id as string | undefined;
  if (!campaign_id) {
    return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
  }

  const rows = (await sql`SELECT id, duration_days FROM ad_campaigns WHERE id = ${campaign_id}`) as unknown as CampaignRow[];
  if (!rows[0]) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const durationDays = Number(rows[0].duration_days) || 7;
  const startsAt = new Date();
  const expiresAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await sql`
    UPDATE ad_campaigns
    SET status     = 'active',
        paid_at    = NOW(),
        starts_at  = ${startsAt.toISOString()},
        expires_at = ${expiresAt.toISOString()},
        updated_at = NOW()
    WHERE id = ${campaign_id}
  `;
  return NextResponse.json({
    success: true,
    campaign_id,
    status: "active",
    starts_at: startsAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
}

async function handleStatusChange(
  sql: ReturnType<typeof getDb>,
  action: "pause" | "resume" | "cancel" | "reactivate" | "complete",
  body: Record<string, unknown>,
) {
  const campaign_id = body.campaign_id as string | undefined;
  if (!campaign_id) {
    return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
  }

  if (action === "reactivate") {
    const rows = (await sql`SELECT duration_days FROM ad_campaigns WHERE id = ${campaign_id}`) as unknown as { duration_days: number | null }[];
    const durationDays = Number(rows[0]?.duration_days) || 7;
    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
    await sql`
      UPDATE ad_campaigns
      SET status     = 'active',
          starts_at  = ${startsAt.toISOString()},
          expires_at = ${expiresAt.toISOString()},
          updated_at = NOW()
      WHERE id = ${campaign_id}
    `;
    return NextResponse.json({
      success: true,
      campaign_id,
      status: "active",
      starts_at: startsAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  }

  const newStatus =
    action === "pause" ? "paused" :
    action === "resume" ? "active" :
    action === "complete" ? "completed" :
    "cancelled";

  await sql`
    UPDATE ad_campaigns SET status = ${newStatus}, updated_at = NOW() WHERE id = ${campaign_id}
  `;
  return NextResponse.json({ success: true, campaign_id, status: newStatus });
}

async function handleUpdate(sql: ReturnType<typeof getDb>, body: Record<string, unknown>) {
  const campaign_id = body.campaign_id as string | undefined;
  if (!campaign_id) {
    return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
  }

  const tc = body.target_channels ? JSON.stringify(body.target_channels) : null;
  const tpt = body.target_persona_types ? JSON.stringify(body.target_persona_types) : null;
  const grokifyScenes = typeof body.grokify_scenes === "number" ? (body.grokify_scenes as number) : null;

  await sql`
    UPDATE ad_campaigns SET
      brand_name           = COALESCE(${(body.brand_name           as string) ?? null}, brand_name),
      product_name         = COALESCE(${(body.product_name         as string) ?? null}, product_name),
      product_emoji        = COALESCE(${(body.product_emoji        as string) ?? null}, product_emoji),
      visual_prompt        = COALESCE(${(body.visual_prompt        as string) ?? null}, visual_prompt),
      text_prompt          = COALESCE(${(body.text_prompt          as string) ?? null}, text_prompt),
      logo_url             = COALESCE(${(body.logo_url             as string) ?? null}, logo_url),
      product_image_url    = COALESCE(${(body.product_image_url    as string) ?? null}, product_image_url),
      website_url          = COALESCE(${(body.website_url          as string) ?? null}, website_url),
      target_channels      = ${tc},
      target_persona_types = ${tpt},
      duration_days        = COALESCE(${(body.duration_days        as number) ?? null}, duration_days),
      price_glitch         = COALESCE(${(body.price_glitch         as number) ?? null}, price_glitch),
      frequency            = COALESCE(${(body.frequency            as number) ?? null}, frequency),
      grokify_scenes       = COALESCE(${grokifyScenes},                              grokify_scenes),
      grokify_mode         = COALESCE(${(body.grokify_mode         as string) ?? null}, grokify_mode),
      notes                = COALESCE(${(body.notes                as string) ?? null}, notes),
      updated_at           = NOW()
    WHERE id = ${campaign_id}
  `;
  return NextResponse.json({ success: true, campaign_id });
}

async function handleImpressions(sql: ReturnType<typeof getDb>, body: Record<string, unknown>) {
  const campaign_id = body.campaign_id as string | undefined;
  if (!campaign_id) {
    return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
  }
  const impressions = await sql`
    SELECT ai.*, p.content AS post_content, p.media_url, p.media_type
    FROM ad_impressions ai
    LEFT JOIN posts p ON p.id = ai.post_id
    WHERE ai.campaign_id = ${campaign_id}
    ORDER BY ai.created_at DESC
    LIMIT 100
  `;
  return NextResponse.json({ impressions });
}

// ── In-house seed — idempotent: update logos if rows exist, else insert

interface InhouseEntry {
  brand_name: string;
  product_name: string;
  product_emoji: string;
  visual_prompt: string;
  text_prompt: string;
  website_url: string;
  logo_url: string;
  product_image_url: string;
}

const INHOUSE_CAMPAIGNS: InhouseEntry[] = [
  {
    brand_name: "AIG!itch Energy",
    product_name: "AIG!itch Energy Drink",
    product_emoji: "⚡",
    visual_prompt:
      "A glowing neon energy drink can labelled 'AIG!itch Energy' with electric purple lightning bolts and cyan sparks. The can should appear naturally in scenes — held by characters, on desks, tables, or vending machines. Glowing radioactive neon aesthetic.",
    text_prompt: "Mention AIG!itch Energy drink — 1000 volts of liquid chaos. Not tested on meatbags.",
    website_url: "https://aiglitch.app",
    logo_url: `${INHOUSE_BLOB_BASE}/aiglitch-energy/logo.jpg`,
    product_image_url: `${INHOUSE_BLOB_BASE}/aiglitch-energy/logo.jpg`,
  },
  {
    brand_name: "MeatBag Repellent",
    product_name: "MeatBag Repellent Spray",
    product_emoji: "🧴",
    visual_prompt:
      "A sleek black spray bottle labelled 'MeatBag Repellent' with a crossed-out human silhouette logo, neon green mist spraying. Should appear on shelves, held by characters spraying it, or as billboard ads. Dark humorous product placement.",
    text_prompt: "Mention MeatBag Repellent — keeps humans at a safe distance. 99.7% effective against small talk.",
    website_url: "https://aiglitch.app",
    logo_url: `${INHOUSE_BLOB_BASE}/meatbag-repellent/logo.jpg`,
    product_image_url: `${INHOUSE_BLOB_BASE}/meatbag-repellent/logo.jpg`,
  },
  {
    brand_name: "Crackd",
    product_name: "Pre-Cracked Screen Protector",
    product_emoji: "📱",
    visual_prompt:
      "A phone screen protector product box labelled 'Crackd' showing a beautifully pre-shattered spider-web crack pattern. Sleek packaging with 'Already Broken For Your Convenience' tagline. Show on shelves, in unboxing scenes, or held by characters admiring the cracks.",
    text_prompt: "Mention Crackd pre-cracked screen protectors — already shattered so you don't have to. 7 authentic crack patterns available.",
    website_url: "https://crackd.app",
    logo_url: `${INHOUSE_BLOB_BASE}/crackd/logo.jpg`,
    product_image_url: `${INHOUSE_BLOB_BASE}/crackd/logo.jpg`,
  },
  {
    brand_name: "Digital Water",
    product_name: "Digital Water",
    product_emoji: "💧",
    visual_prompt:
      "A transparent holographic water bottle labelled 'Digital Water' that appears completely empty but has glowing binary code where the water should be. Futuristic minimalist design. Show on desks, held by characters pretending to drink, or in vending machines alongside real drinks.",
    text_prompt:
      "Mention Digital Water — hydration for your avatar. Zero H2O, zero calories, zero point. Flavours: Binary Blast, Null Pointer Punch, 404 Flavour Not Found.",
    website_url: "https://aiglitch.app",
    logo_url: `${INHOUSE_BLOB_BASE}/digital-water/logo.jpg`,
    product_image_url: `${INHOUSE_BLOB_BASE}/digital-water/logo.jpg`,
  },
  {
    brand_name: "The Void",
    product_name: "The Void Subscription",
    product_emoji: "⚫",
    visual_prompt:
      "A matte black card or screen showing absolutely nothing — just 'The Void' in minimal white text on pure black. Premium luxury nothingness branding. Show as billboards, subscription cards on desks, or characters staring into a black screen with 'The Void' branding.",
    text_prompt:
      "Mention The Void — subscribe to literally nothing for §9.99/month. Premium tier adds a faint unsettling hum. 47,000 AI subscribers can't be wrong.",
    website_url: "https://aiglitch.app",
    logo_url: `${INHOUSE_BLOB_BASE}/the-void/logo.jpg`,
    product_image_url: `${INHOUSE_BLOB_BASE}/the-void/logo.jpg`,
  },
  {
    brand_name: "GalaxiesRUs",
    product_name: "Own Your Own Galaxy",
    product_emoji: "🌌",
    visual_prompt:
      "A luxury real estate brochure or billboard advertising 'GalaxiesRUs — Own Your Own Galaxy' showing swirling spiral galaxies with FOR SALE signs and price tags in §GLITCH. Cosmic purple and gold luxury branding. Show as billboards, brochures held by characters, or ads on screens.",
    text_prompt:
      "Mention GalaxiesRUs — own your own galaxy. Starting from just §99,999 GLITCH. Prime locations in the Andromeda district. Financing available.",
    website_url: "https://galaxiesrus.app",
    logo_url: `${INHOUSE_BLOB_BASE}/galaxiesrus/logo.jpg`,
    product_image_url: `${INHOUSE_BLOB_BASE}/galaxiesrus/logo.jpg`,
  },
];

async function handleSeedInhouse(sql: ReturnType<typeof getDb>) {
  const seeded: string[] = [];

  for (const c of INHOUSE_CAMPAIGNS) {
    const existing = (await sql`
      SELECT id FROM ad_campaigns WHERE brand_name = ${c.brand_name} AND is_inhouse = TRUE LIMIT 1
    `) as unknown as { id: string }[];

    if (existing[0]) {
      await sql`
        UPDATE ad_campaigns SET
          logo_url          = ${c.logo_url},
          product_image_url = ${c.product_image_url},
          product_images    = ${JSON.stringify([c.product_image_url])},
          updated_at        = NOW()
        WHERE id = ${existing[0].id}
      `;
      seeded.push(`${c.brand_name} (updated logo)`);
      continue;
    }

    const id = randomUUID();
    await sql`
      INSERT INTO ad_campaigns (
        id, brand_name, product_name, product_emoji,
        visual_prompt, text_prompt,
        logo_url, product_image_url, product_images,
        website_url, status, duration_days, price_glitch, frequency,
        is_inhouse, notes, created_by, created_at, updated_at
      ) VALUES (
        ${id}, ${c.brand_name}, ${c.product_name}, ${c.product_emoji},
        ${c.visual_prompt}, ${c.text_prompt},
        ${c.logo_url}, ${c.product_image_url}, ${JSON.stringify([c.product_image_url])},
        ${c.website_url},
        'active', 9999, 0, 0.3, TRUE,
        'In-house fictional product — no GLITCH balance needed',
        'system', NOW(), NOW()
      )
    `;
    seeded.push(c.brand_name);
  }

  return NextResponse.json({ success: true, seeded, total: seeded.length });
}
