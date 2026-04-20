/**
 * GET  /api/sponsor-burn — Vercel cron invocation (daily 12am UTC, CRON_SECRET)
 * POST /api/sponsor-burn — admin manual trigger (ADMIN_PASSWORD or wallet)
 *
 * Per-campaign burn: every active ad_campaign that has started and has not
 * been burned today gets its daily rate deducted from the matched sponsor's
 * glitch_balance.
 *
 * Daily rate  = totalInvestment / duration_days
 * totalInvestment = sponsor.glitch_balance + sponsor.total_spent
 *
 * Catch-up: if last_burn_at is behind, all missed days are burned in one pass.
 * Idempotent: last_burn_at guards against double-burn on the same calendar day.
 * In-house campaigns (is_inhouse = TRUE) are excluded — no GLITCH cost.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Campaign {
  id: string;
  brand_name: string;
  price_glitch: number;
  duration_days: number;
  starts_at: string;
  expires_at: string | null;
  last_burn_at: string | null;
}

interface Sponsor {
  id: number;
  glitch_balance: number;
  total_spent: number;
}

interface BurnResult {
  brand: string;
  dailyRate: number;
  newBalance: number;
  expired: boolean;
}

async function processBurn(): Promise<{ burned: number; results?: BurnResult[]; message?: string }> {
  const sql = getDb();

  await sql`ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS last_burn_at TIMESTAMPTZ`;

  const campaigns = (await sql`
    SELECT ac.id, ac.brand_name, ac.price_glitch, ac.duration_days,
           ac.starts_at, ac.expires_at, ac.last_burn_at
    FROM ad_campaigns ac
    WHERE ac.status IN ('active', 'completed', 'paused')
      AND ac.starts_at IS NOT NULL
      AND ac.starts_at <= NOW()
      AND (ac.is_inhouse IS NULL OR ac.is_inhouse = FALSE)
      AND (ac.last_burn_at IS NULL OR ac.last_burn_at < CURRENT_DATE)
  `) as unknown as Campaign[];

  if (campaigns.length === 0) {
    return { burned: 0, message: "No campaigns to burn today" };
  }

  const results: BurnResult[] = [];

  for (const c of campaigns) {
    const sponsors = (await sql`
      SELECT id, glitch_balance, total_spent FROM sponsors
      WHERE LOWER(company_name) = LOWER(${c.brand_name})
      LIMIT 1
    `) as unknown as Sponsor[];

    if (sponsors.length === 0) {
      console.log(`[sponsor-burn] No sponsor found for brand "${c.brand_name}" — skipping`);
      continue;
    }

    const sponsor = sponsors[0]!;
    const totalInvestment = sponsor.glitch_balance + sponsor.total_spent;
    const dailyRate = Math.round(totalInvestment / (c.duration_days || 7));

    const startDate = new Date(c.starts_at);
    const lastBurn = c.last_burn_at ? new Date(c.last_burn_at) : startDate;
    const now = new Date();
    const endDate = c.expires_at
      ? new Date(c.expires_at)
      : new Date(startDate.getTime() + (c.duration_days || 7) * 86400000);
    const burnUntil = now < endDate ? now : endDate;
    const daysToBurn = Math.max(
      0,
      Math.floor((burnUntil.getTime() - lastBurn.getTime()) / 86400000),
    );

    if (daysToBurn === 0) continue;

    const burnAmount = Math.min(dailyRate * daysToBurn, sponsor.glitch_balance);
    const newBalance = Math.max(0, sponsor.glitch_balance - burnAmount);
    const newSpent = sponsor.total_spent + burnAmount;

    await sql`
      UPDATE sponsors
      SET glitch_balance = ${newBalance},
          total_spent    = ${newSpent},
          updated_at     = NOW()
      WHERE id = ${sponsor.id}
    `;

    await sql`
      UPDATE ad_campaigns
      SET last_burn_at = NOW(),
          updated_at   = NOW()
      WHERE id = ${c.id}
    `;

    const isExpired =
      newBalance <= 0 ||
      (c.expires_at !== null && new Date(c.expires_at).getTime() <= Date.now());
    if (isExpired) {
      await sql`
        UPDATE ad_campaigns
        SET status = 'completed', updated_at = NOW()
        WHERE id = ${c.id} AND status = 'active'
      `;
    }

    results.push({ brand: c.brand_name, dailyRate: burnAmount, newBalance, expired: newBalance <= 0 });
  }

  return { burned: results.length, results };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("sponsor-burn", processBurn);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[sponsor-burn] error:", err);
    return NextResponse.json({ error: "Sponsor burn failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processBurn();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[sponsor-burn] error:", err);
    return NextResponse.json({ error: "Sponsor burn failed" }, { status: 500 });
  }
}
