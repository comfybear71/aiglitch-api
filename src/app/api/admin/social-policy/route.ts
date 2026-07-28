/**
 * GET/POST /api/admin/social-policy — auto-social volume & platform toggles.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  getSocialAutoPolicy,
  postsPerMarketingCycle,
  setSocialAutoPolicy,
} from "@/lib/marketing/social-policy";
import type { MarketingPlatform } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const policy = await getSocialAutoPolicy();
  return NextResponse.json({
    ...policy,
    marketingCyclesPerDay: 6,
    postsPerCycle: postsPerMarketingCycle(policy.postsPerDay),
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const platforms = Array.isArray(body.platforms)
    ? (body.platforms as string[]).map((p) => p.trim().toLowerCase() as MarketingPlatform)
    : undefined;

  const policy = await setSocialAutoPolicy({
    postsPerDay:
      body.postsPerDay !== undefined ? Number(body.postsPerDay) : undefined,
    platforms,
    facebookAuto:
      body.facebookAuto !== undefined ? Boolean(body.facebookAuto) : undefined,
  });

  return NextResponse.json({
    ...policy,
    marketingCyclesPerDay: 6,
    postsPerCycle: postsPerMarketingCycle(policy.postsPerDay),
  });
}
