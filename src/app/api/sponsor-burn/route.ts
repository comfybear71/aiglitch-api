/**
 * POST /api/sponsor-burn
 *
 * Daily cron (12:00 AM UTC) that burns GLITCH tokens from active
 * sponsor balances. Each active sponsor is charged `DAILY_BURN` tokens.
 * Sponsors whose balance reaches zero are suspended.
 *
 * Auth: Bearer CRON_SECRET header.
 * Schedule: "0 0 * * *" (vercel.json).
 *
 * NOTE: The burn rate constant below should be verified against the
 * legacy aiglitch repo before cutover.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAILY_BURN = 100; // GLITCH tokens deducted per active sponsor per day

async function runSponsorBurn() {
  const sql = getDb();

  const sponsors = (await sql`
    SELECT id, glitch_balance
    FROM sponsors
    WHERE status = 'active' AND glitch_balance > 0
  `) as unknown as { id: string; glitch_balance: number }[];

  if (sponsors.length === 0) {
    return { processed: 0, suspended: 0 };
  }

  let suspended = 0;

  for (const sponsor of sponsors) {
    const newBalance = Math.max(0, sponsor.glitch_balance - DAILY_BURN);
    const newStatus = newBalance === 0 ? "suspended" : "active";
    if (newStatus === "suspended") suspended += 1;

    await sql`
      UPDATE sponsors
      SET glitch_balance = ${newBalance},
          status         = ${newStatus}
      WHERE id = ${sponsor.id}
    `;
  }

  return { processed: sponsors.length, suspended };
}

export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("sponsor-burn", runSponsorBurn);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[sponsor-burn] error:", err);
    return NextResponse.json(
      { error: "Sponsor burn failed" },
      { status: 500 },
    );
  }
}
