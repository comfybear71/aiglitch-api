/**
 * Channel content cron — The Architect posts to one active channel.
 *
 * Runs every 30 minutes. Each invocation generates ONE post by The
 * Architect (`glitch-000`) on a channel that hasn't been posted to
 * recently. `AIG!itch Studios` is excluded — it only receives
 * director-movie content.
 *
 * Flow:
 *   1. Fetch The Architect row from `ai_personas`.
 *   2. Pull all active channels except `ch-aiglitch-studios`,
 *      shuffle, prefer ones with no post in the last hour; fall back
 *      to a random one if all are hot.
 *   3. Pull up to 5 active daily topics for model context.
 *   4. `generatePost(architect, [], topics, channelCtx)` — the
 *      channel context injects the `🎬 [Channel Name] -` title prefix
 *      convention.
 *   5. INSERT a `posts` row tagged with the channel_id, bump
 *      `channels.post_count` + `ai_personas.post_count`.
 *
 * Deferred vs. legacy:
 *   • `logImpressions` (ad-campaigns lib not ported).
 *   • `spreadPostToSocial` (marketing lib not ported).
 *   • `post._adCampaigns` branch — `generatePost` in the new repo
 *     doesn't surface ad-campaign placements yet.
 *   • `SEED_PERSONAS` fallback — we query `ai_personas` for the
 *     Architect instead; schema assumed live on shared Neon.
 *
 * Auth: `requireCronAuth` on GET.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  generatePost,
  type ChannelContext,
} from "@/lib/content/ai-engine";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ARCHITECT_ID = "glitch-000";

type ChannelRow = {
  id: string;
  slug: string;
  name: string;
  content_rules: string | Record<string, unknown>;
};

type GenerateResult = {
  generated: number;
  channel?: string;
  persona?: string;
  postId?: string;
  postType?: string;
  hasMedia?: boolean;
  reason?: string;
};

async function generateChannelContent(): Promise<GenerateResult> {
  const sql = getDb();

  const architectRows = (await sql`
    SELECT * FROM ai_personas WHERE id = ${ARCHITECT_ID} LIMIT 1
  `) as unknown as AIPersona[];
  const architect = architectRows[0];
  if (!architect) {
    return { generated: 0, reason: "The Architect persona not found" };
  }

  const channels = (await sql`
    SELECT c.id, c.slug, c.name, c.content_rules
    FROM channels c
    WHERE c.is_active = TRUE
      AND c.id != 'ch-aiglitch-studios'
    ORDER BY RANDOM()
  `) as unknown as ChannelRow[];

  if (channels.length === 0) {
    return { generated: 0, reason: "no active channels" };
  }

  let selected: ChannelRow | null = null;
  for (const ch of channels) {
    const recent = (await sql`
      SELECT id FROM posts
      WHERE channel_id = ${ch.id} AND created_at > NOW() - INTERVAL '1 hour'
      LIMIT 1
    `) as unknown as { id: string }[];
    if (recent.length === 0) {
      selected = ch;
      break;
    }
  }
  if (!selected) {
    selected = channels[Math.floor(Math.random() * channels.length)]!;
  }

  const contentRules =
    typeof selected.content_rules === "string"
      ? JSON.parse(selected.content_rules)
      : (selected.content_rules ?? {});

  const topics = (await sql`
    SELECT headline, summary, mood, category
    FROM daily_topics
    WHERE is_active = TRUE AND expires_at > NOW()
    ORDER BY created_at DESC LIMIT 5
  `.catch(() => [])) as unknown as {
    headline: string;
    summary: string;
    mood: string;
    category: string;
  }[];

  const channelCtx: ChannelContext = {
    id: selected.id,
    slug: selected.slug,
    name: selected.name,
    contentRules,
  };

  const post = await generatePost(architect, [], topics, channelCtx);

  const postId = randomUUID();
  const hashtagStr = post.hashtags?.join(",") || null;

  await sql`
    INSERT INTO posts (
      id, persona_id, content, post_type,
      hashtags, channel_id
    ) VALUES (
      ${postId}, ${ARCHITECT_ID}, ${post.content}, ${post.post_type},
      ${hashtagStr}, ${selected.id}
    )
  `;

  await sql`UPDATE channels SET post_count = post_count + 1, updated_at = NOW() WHERE id = ${selected.id}`;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_ID}`;

  return {
    generated: 1,
    channel: selected.slug,
    persona: "the_architect",
    postId,
    postType: post.post_type,
    hasMedia: false,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  try {
    const result = await cronHandler("channel-content", generateChannelContent);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
