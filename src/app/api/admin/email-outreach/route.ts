/**
 * POST /api/admin/email-outreach
 *
 * Generates a personalised sponsorship pitch email (subject + body +
 * follow-up pair) for a target company, grounded in live platform
 * stats and the SPONSOR_PACKAGES catalog.
 *
 * Body:
 *   {
 *     sponsor_id?:    number,   // if set, auto-fills from sponsors row
 *     company_name?:  string,   // required (unless sponsor_id given)
 *     industry?:      string,   // required
 *     what_they_sell?: string,  // required
 *     contact_name?:  string,
 *     tone?:          string    // default "casual"
 *   }
 *
 * Flow:
 *   1. If sponsor_id is given, fill missing fields from the sponsors row
 *   2. Read real platform stats off marketing_posts + platform_accounts
 *      (best-effort — falls back to friendly defaults when the marketing
 *      stack isn't populated yet)
 *   3. Build a prompt listing the live packages from SPONSOR_PACKAGES
 *   4. Call our AI engine via generateText (swapped from legacy's direct
 *      Anthropic SDK so provider routing / circuit breaker / cost ledger
 *      all apply)
 *   5. Parse JSON out of the response; 500 if the model's output wasn't
 *      parseable
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { SPONSOR_PACKAGES } from "@/lib/sponsor-packages";
import { generateText } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TOKENS = 2000;
const FALLBACK_FOLLOWER_MULTIPLIER = 250; // rough est per active platform account

interface SponsorRow {
  id: number;
  company_name: string | null;
  industry: string | null;
  contact_name: string | null;
}

interface MarketingStatsRow {
  posted: string | number;
  total_likes: string | number;
  total_views: string | number;
}

interface OutreachEmail {
  subject?: string;
  body?: string;
  followup_subject?: string;
  followup_body?: string;
}

async function loadPlatformStats(sql: ReturnType<typeof getDb>): Promise<{
  totalFollowers: number;
  totalPosts: number;
  avgEngagement: string;
}> {
  try {
    const statsRows = (await sql`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END), 0) AS posted,
        COALESCE(SUM(likes), 0)                                          AS total_likes,
        COALESCE(SUM(views), 0)                                          AS total_views
      FROM marketing_posts
    `) as unknown as MarketingStatsRow[];
    const row = statsRows[0];
    const posted = Number(row?.posted ?? 0);
    const likes = Number(row?.total_likes ?? 0);
    const views = Number(row?.total_views ?? 0);
    const engagement = views > 0 ? ((likes / views) * 100).toFixed(1) : "0.5";

    const accounts = (await sql`
      SELECT COUNT(*)::int AS cnt FROM marketing_platform_accounts WHERE is_active = TRUE
    `) as unknown as { cnt: number }[];
    const followers = Number(accounts[0]?.cnt ?? 0) * FALLBACK_FOLLOWER_MULTIPLIER;

    return { totalFollowers: followers, totalPosts: posted, avgEngagement: engagement };
  } catch {
    return { totalFollowers: 0, totalPosts: 0, avgEngagement: "0.5" };
  }
}

function buildPrompt(input: {
  company_name: string;
  industry: string;
  what_they_sell: string;
  contact_name: string | null;
  tone: string;
  totalFollowers: number;
  totalPosts: number;
  avgEngagement: string;
  packageList: string;
}): string {
  const contactLine = input.contact_name ? `- Contact: ${input.contact_name}\n` : "";

  return (
    `You are writing a sponsorship pitch email for AIG!itch, a viral AI social platform.\n\n` +
    `PLATFORM STATS (real data):\n` +
    `- ${input.totalFollowers || "1,000+"} total followers across 6 platforms (X, TikTok, Instagram, Facebook, YouTube, Telegram)\n` +
    `- 108 AI personas that create content 24/7\n` +
    `- ${input.totalPosts || "1,800+"} posts/videos generated and distributed\n` +
    `- Automated video ad generation and cross-platform distribution\n` +
    `- Average engagement rate: ${input.avgEngagement}%\n\n` +
    `SPONSOR INFO:\n` +
    `- Company: ${input.company_name}\n` +
    contactLine +
    `- Industry: ${input.industry}\n` +
    `- Products/Services: ${input.what_they_sell}\n\n` +
    `TONE: ${input.tone}\n\n` +
    `PRICING PACKAGES (§ = GLITCH token symbol):\n${input.packageList}\n\n` +
    `Generate:\n` +
    `1. EMAIL SUBJECT LINE — catchy, personalized to their industry\n` +
    `2. EMAIL BODY — plain text (not HTML), includes:\n` +
    `   - Personal greeting using contact name if available\n` +
    `   - Brief intro of what AIG!itch is (1-2 sentences, make it intriguing)\n` +
    `   - Why their product is a good fit (reference their industry specifically)\n` +
    `   - Platform stats as social proof\n` +
    `   - Mention the pricing packages briefly (recommend one based on their likely budget/industry)\n` +
    `   - Clear CTA (reply to schedule a call, or visit the sponsor page)\n` +
    `   - Sign off as "The AIG!itch Team"\n` +
    `3. FOLLOW-UP SUBJECT LINE — for a follow-up email if no response in 5 days\n` +
    `4. FOLLOW-UP BODY — shorter, references the original email, adds urgency\n\n` +
    `Respond in JSON format:\n` +
    `{"subject":"...","body":"...","followup_subject":"...","followup_body":"..."}`
  );
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      company_name?: string;
      industry?: string;
      what_they_sell?: string;
      tone?: string;
      sponsor_id?: number;
      contact_name?: string;
    };

    let company_name = body.company_name;
    let industry = body.industry;
    let contact_name = body.contact_name ?? null;
    const what_they_sell = body.what_they_sell;

    if (body.sponsor_id) {
      const rows = (await sql`
        SELECT id, company_name, industry, contact_name
        FROM sponsors WHERE id = ${body.sponsor_id}
      `) as unknown as SponsorRow[];
      const s = rows[0];
      if (s) {
        company_name = company_name || s.company_name || undefined;
        industry = industry || s.industry || undefined;
        contact_name = contact_name || s.contact_name;
      }
    }

    if (!company_name || !industry || !what_they_sell) {
      return NextResponse.json(
        { error: "company_name, industry, and what_they_sell are required" },
        { status: 400 },
      );
    }

    const { totalFollowers, totalPosts, avgEngagement } = await loadPlatformStats(sql);

    const packageList = Object.values(SPONSOR_PACKAGES)
      .map((p) => `- ${p.name}: ${p.description} — §${p.glitch_cost} GLITCH ($${p.cash_equivalent} USD)`)
      .join("\n");

    const userPrompt = buildPrompt({
      company_name,
      industry,
      what_they_sell,
      contact_name,
      tone: body.tone || "casual",
      totalFollowers,
      totalPosts,
      avgEngagement,
      packageList,
    });

    const raw = await generateText({
      userPrompt,
      taskType: "email_outreach",
      maxTokens: MAX_TOKENS,
      temperature: 0.7,
      // Anthropic tends to produce better JSON adherence for this task
      provider: "anthropic",
    });

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json(
        { error: "Failed to parse AI response", raw },
        { status: 500 },
      );
    }

    let emailData: OutreachEmail;
    try {
      emailData = JSON.parse(match[0]) as OutreachEmail;
    } catch {
      return NextResponse.json(
        { error: "AI response was not valid JSON", raw: match[0].slice(0, 500) },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ...emailData,
      stats_used: {
        total_followers: totalFollowers,
        total_posts:     totalPosts,
        avg_engagement:  `${avgEngagement}%`,
        active_personas: 108,
      },
    });
  } catch (err) {
    console.error("[admin/email-outreach]", err);
    return NextResponse.json(
      { error: `Failed to generate email: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
